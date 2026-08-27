import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { graphBaseDir, readManifest } from "./storage.ts";
import { assertReferenceTarget, listFolderEntries, loadPrepare, readJobRecord, readPreparedSources, referenceTargetOf, supportedFolderPath, updateJobRecord, validFolderPath, validReferenceTarget, type ExplainJobRecord, type ExplainReferenceTarget } from "./explain-artifacts.ts";
import { pickNativeFile, type NativePickerKind } from "./native-picker.ts";
import { readValidatedExplainFinal } from "@icomposer/workbench-contracts/ici-explain";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";

export const EXPLAIN_ROUTES_PREFIX = "/api/icomposer-workbench/ici/explain" as const;
const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 64 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._:-]{1,256}$/;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`])\/(?:Users|home|private|tmp|var|opt|etc)\/|[A-Za-z]:[\\/]/i;
const SECRET_PATTERN = /(authorization\s*:|bearer\s+|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i;
interface Binding { list(): Promise<{ ok: boolean; value?: readonly { workspaceId: string; canonicalPath: string }[] }>; }
interface Engine { explainPrepare(input: { workspaceId: string; query: string }, signal?: AbortSignal): Promise<{ ok: boolean; value?: any; error?: { code?: string } }>; }
interface Llm { listProviders(): readonly { id: string }[]; listModels?(provider: string): Promise<readonly { id: string; name?: string }[]>; resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>; }
interface DirectoryPicker { capability(): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> } | undefined; }
export interface NativeFilePicker { pick(signal: AbortSignal): Promise<string | null>; }
export interface ExplainRoutesConfig { readonly nativeFilePicker?: NativeFilePicker; }
interface Scheduler { cancelJob(jobId: string): Promise<boolean>; poke(): void; }
interface WebServer { register(route: { kind: "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void; }

type Located = { readonly root: string; readonly job: ExplainJobRecord };
function response(res: ServerResponse, status: number, body: unknown): void { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body)); }
function ok(res: ServerResponse, result: unknown): void { response(res, 200, { ok: true, result }); }
function fail(res: ServerResponse, status: number, code: string): void { response(res, status, { ok: false, error: { code, message: code } }); }
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers["content-length"] ?? 0); if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength; if (bytes > MAX_BODY_BYTES) return null; chunks.push(value); }
  if (chunks.length === 0) return {};
  try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function safeString(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_NAME.test(value) && !/(authorization|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i.test(value); }
function safeModel(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value) && !/(authorization|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i.test(value); }
function safeProvider(value: unknown): value is string { return safeModel(value); }
function normalizeNotBefore(value: unknown): string | null { const now = Date.now(); const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : now; if (!Number.isFinite(parsed)) return null; if (parsed > now + 14 * 24 * 60 * 60 * 1000) return null; return new Date(Math.max(now, parsed)).toISOString(); }
function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function validDocPath(value: unknown): value is string { return typeof value === "string" && value.length <= 512 && value.startsWith("ref_doc/") && !value.includes("\\") && !value.split("/").includes("..") && !value.includes("\0"); }
function statusCode(code: string): number { return code === "job-missing" ? 404 : code === "job-active" || code === "revision-conflict" || code === "stale-snapshot" || code === "source-changed" || code === "folder-changed" ? 409 : code === "storage-error" ? 500 : 422; }
function targetFromBody(body: Record<string, unknown>, current: ExplainJobRecord): ExplainReferenceTarget | null { const fields = ["referenceTarget", "reference_target", "target"].filter(key => Object.prototype.hasOwnProperty.call(body, key)); if (fields.length > 1) return null; const legacy = body.folderPath ?? body.folder_path; const target = fields.length === 1 ? (validReferenceTarget(body[fields[0]]) ? body[fields[0]] as ExplainReferenceTarget : null) : legacy === undefined ? referenceTargetOf(current) : validFolderPath(legacy) ? { path: legacy, kind: "directory" as const } : null; if (!target) return null; if (legacy !== undefined && (typeof legacy !== "string" || legacy !== target.path)) return null; return target; }
const PICKER_CODES = new Set(["picker-cancelled", "picker-aborted", "picker-unavailable", "picker-failed", "reference-outside-workspace", "reference-symlink", "reference-unsupported"]);
function isOutside(relativePath: string): boolean { return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath); }
/** Convert a native absolute selection into a workspace-relative target without exposing the absolute path. */
export async function normalizeNativePickedTarget(root: string, selected: unknown, kind: NativePickerKind): Promise<ExplainReferenceTarget> {
  if (typeof selected !== "string" || !isAbsolute(selected) || selected.includes("\0") || /[\u0000-\u001f\u007f]/.test(selected) || selected.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("reference-outside-workspace");
  try {
    const rootInfo = await lstat(root); if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("picker-failed");
    const rootAbsolute = resolve(root); const rootReal = await realpath(root); const selectedAbsolute = resolve(selected); const lexical = relative(rootAbsolute, selectedAbsolute);
    if (isOutside(lexical)) throw new Error("reference-outside-workspace");
    let cursor = rootAbsolute;
    for (const part of lexical === "" ? [] : lexical.split(sep)) { if (part === "" || part === "." || part === "..") throw new Error("reference-outside-workspace"); cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error("reference-symlink"); }
    const selectedReal = await realpath(selectedAbsolute); const actual = relative(rootReal, selectedReal); if (isOutside(actual)) throw new Error("reference-outside-workspace");
    const info = await lstat(selectedReal); if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new Error("reference-unsupported");
    const path = actual.split(sep).join("/"); if (kind === "file" && !supportedFolderPath(path)) throw new Error("reference-unsupported");
    const target: ExplainReferenceTarget = { path, kind }; await assertReferenceTarget(rootReal, target); return target;
  } catch (cause) { if (cause instanceof Error && PICKER_CODES.has(cause.message)) throw cause; throw new Error("picker-failed"); }
}

export class ExplainRoutesService extends Service {
  static inject = ["webServer", "workspaceBinding", "iciEngine", "llm", "iciExplainScheduler"] as const;
  #dispose: (() => void) | undefined;
  #nativeFilePicker: NativeFilePicker | undefined;
  constructor(ctx: Context, config: ExplainRoutesConfig = {}) { super(ctx, "iciExplainRoutes" as never); this.#nativeFilePicker = config.nativeFilePicker; }
  protected [Service.init](): void {
    const web = this.ctx.get("webServer") as WebServer | undefined;
    if (!web) return;
    this.#dispose = web.register({ kind: "prefix", path: EXPLAIN_ROUTES_PREFIX, handler: (req, res) => this.handle(req, res) });
    this.ctx.effect(() => () => this.#dispose?.(), "iciExplainRoutes.dispose");
  }
  private async locate(jobId: string): Promise<Located | null> {
    if (!/^[a-f0-9]{16}$/.test(jobId)) return null;
    const binding = this.ctx.get("workspaceBinding") as Binding | undefined; if (!binding) return null;
    const listed = await binding.list().catch(() => ({ ok: false, value: undefined })); if (!listed.ok) return null;
    for (const entry of listed.value ?? []) { const job = await readJobRecord(entry.canonicalPath, jobId); if (job) return { root: entry.canonicalPath, job }; }
    return null;
  }
  private async providers(): Promise<readonly { id: string; models: readonly { id: string; name: string }[] }[]> {
    const llm = this.ctx.get("llm") as Llm | undefined; if (!llm) return [];
    const output: Array<{ id: string; models: { id: string; name: string }[] }> = [];
    let listed: readonly { id: string }[] = []; try { listed = llm.listProviders(); } catch { return []; }
    for (const item of listed) {
      if (!safeProvider(item.id)) continue;
      let models: { id: string; name: string }[] = [];
      try { models = (await llm.listModels?.(item.id) ?? []).filter(model => safeModel(model.id)).map(model => ({ id: model.id, name: typeof model.name === "string" && model.name.length > 0 && model.name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(model.name) && !SECRET_PATTERN.test(model.name) && !ABSOLUTE_PATH_PATTERN.test(model.name) ? model.name : model.id })); } catch { /* unavailable catalog */ }
      output.push({ id: item.id, models });
    }
    return output;
  }
  private async getJob(located: Located, res: ServerResponse): Promise<void> {
    let prepare: any; try { prepare = await loadPrepare(located.root, located.job.prepareArtifactPath); } catch { fail(res, 409, "prepare-invalidated"); return; }
    const final = await readValidatedExplainFinal(located.root, located.job.apiName, located.job.workspaceId);
    const committed = final?.final?.prepareId === located.job.prepareId && final.artifactPath.endsWith(`${located.job.jobId}.json`) ? final : null;
    ok(res, {
      job: { jobId: located.job.jobId, workspaceId: located.job.workspaceId, apiId: located.job.apiId, apiName: located.job.apiName, provider: located.job.provider, model: located.job.model, engineVersion: located.job.engineVersion, status: located.job.status, revision: located.job.revision, docs: located.job.docs, error: located.job.error, notBefore: located.job.notBefore, folderPath: located.job.folderPath, referenceTarget: referenceTargetOf(located.job), artifactPath: committed?.artifactPath },
      summary: { nodes: prepare.callChain.nodes.length, edges: prepare.callChain.edges.length, sourceFiles: prepare.sources.length, readableSources: prepare.sources.filter((ref: any) => ref.readable).length, references: prepare.references.filter((ref: any) => ref.readable).length, sourceBytes: prepare.sources.reduce((sum: number, ref: any) => sum + (ref.readable ? ref.bytes : 0), 0), promptBaseBytes: Buffer.byteLength(JSON.stringify(prepare.callChain), "utf8") + prepare.sources.reduce((sum: number, ref: any) => sum + (ref.readable ? ref.bytes : 0), 0) + 1024, truncated: prepare.callChain.truncated === true },
      references: prepare.references.map((ref: any) => ({ path: ref.path, sha256: ref.sha256, bytes: ref.bytes, readable: ref.readable })),
      folderPath: located.job.folderPath,
      referenceTarget: referenceTargetOf(located.job),
      sourceBytes: prepare.sources.reduce((sum: number, ref: any) => sum + (ref.readable ? ref.bytes : 0), 0),
      providers: await this.providers(),
      consent: "The background AI will read only the selected workspace-relative reference target and send selected source excerpts and directory material to the chosen model."
    });
  }
  private async folder(located: Located, url: URL, res: ServerResponse): Promise<void> { const selected = referenceTargetOf(located.job); const folderPath = url.searchParams.get("path") ?? (selected.kind === "directory" ? selected.path : selected.path.slice(0, selected.path.lastIndexOf("/"))); if (!validFolderPath(folderPath)) { fail(res, 422, "folder-forbidden"); return; } try { const entries = await listFolderEntries(located.root, folderPath); const slash = folderPath.lastIndexOf("/"); ok(res, { folderPath, parentPath: slash > 0 ? folderPath.slice(0, slash) : null, entries: entries.filter(entry => entry.kind === "directory" || entry.supported === true), unsupportedCount: entries.filter(entry => entry.kind === "file" && entry.supported === false).length }); } catch { fail(res, 422, "folder-forbidden"); } }
  private async confirm(located: Located, body: Record<string, unknown>, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!["awaiting-input", "scheduled"].includes(located.job.status)) { fail(res, 409, "revision-conflict"); return; }
    const notBeforeValue = body.notBefore ?? body.not_before; const target = targetFromBody(body, located.job); if (Object.prototype.hasOwnProperty.call(body, "folderPath") && Object.prototype.hasOwnProperty.call(body, "folder_path") || Object.prototype.hasOwnProperty.call(body, "notBefore") && Object.prototype.hasOwnProperty.call(body, "not_before")) { fail(res, 422, "confirmation-invalid"); return; } if (!hasOnly(body, ["provider", "model", "docs", "folderPath", "folder_path", "referenceTarget", "reference_target", "target", "consent", "notBefore", "not_before"]) || body.consent !== true || !safeProvider(body.provider) || !safeModel(body.model) || !Array.isArray(body.docs) || body.docs.length > 50 || target === null) { fail(res, 422, "confirmation-invalid"); return; }
    const docs = body.docs.map(item => typeof item === "object" && item !== null ? item as Record<string, unknown> : null);
    if (docs.some(doc => doc === null || !validDocPath(doc.path) || typeof doc.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(doc.sha256))) { fail(res, 422, "confirmation-invalid"); return; }
    const notBefore = normalizeNotBefore(notBeforeValue); if (notBefore === null) { fail(res, 422, "confirmation-invalid"); return; }
    const llm = this.ctx.get("llm") as Llm | undefined; let providerValid = false; try { providerValid = llm?.listProviders().some(item => item.id === body.provider) === true; } catch { providerValid = false; }
    if (!providerValid) { fail(res, 422, "confirmation-invalid"); return; }
    try {
      const prepare = await loadPrepare(located.root, located.job.prepareArtifactPath); const manifest = await readManifest(graphBaseDir(located.root, located.job.workspaceId));
      if (!manifest || located.job.engineVersion !== ICI_ENGINE_VERSION || manifest.engineVersion !== ICI_ENGINE_VERSION || prepare.manifest.engineVersion !== ICI_ENGINE_VERSION || manifest.sourceFingerprint !== located.job.sourceFingerprint || manifest.graphDigest !== located.job.graphDigest || prepare.prepareId !== located.job.prepareId) { fail(res, 409, "stale-snapshot"); return; }
      if (docs.some(doc => !prepare.references.some(ref => ref.readable && ref.path === doc!.path && ref.sha256 === doc!.sha256))) { fail(res, 422, "confirmation-invalid"); return; }
      for (const doc of docs) { const file = (await readPreparedSources(located.root, located.job.workspaceId, located.job.prepareArtifactPath, [], [doc!.path as string], signal))[0]; if (!file || file.sha256 !== doc!.sha256) { fail(res, 409, "source-changed"); return; } }
      await assertReferenceTarget(located.root, target); if (llm?.resolveModelInfo) { try { await llm.resolveModelInfo(body.provider as string, body.model as string, signal); } catch { fail(res, 422, "confirmation-invalid"); return; } }
      const updated = await updateJobRecord(located.root, located.job.jobId, located.job.revision, { provider: body.provider as string, model: body.model as string, docs: docs.map(doc => ({ path: doc!.path as string, sha256: doc!.sha256 as string })), folderPath: target.path, referenceTarget: target, notBefore, status: "scheduled" });
      (this.ctx.get("iciExplainScheduler") as Scheduler | undefined)?.poke(); ok(res, { jobId: updated.jobId, status: updated.status, revision: updated.revision, notBefore: updated.notBefore, folderPath: updated.folderPath, referenceTarget: referenceTargetOf(updated) });
    } catch (cause) { const code = cause instanceof Error && ["revision-conflict", "stale-snapshot", "confirmation-invalid", "folder-forbidden", "folder-changed"].includes(cause.message) ? cause.message : "storage-error"; fail(res, statusCode(code), code); }
  }
  private async nativePick(located: Located, body: Record<string, unknown>, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!["awaiting-input", "scheduled"].includes(located.job.status)) { fail(res, 409, "revision-conflict"); return; }
    if (!hasOnly(body, ["kind"]) || (body.kind !== "file" && body.kind !== "directory")) { fail(res, 422, "confirmation-invalid"); return; }
    try {
      const kind = body.kind as NativePickerKind; let selected: string | null;
      if (kind === "directory") {
        const picker = this.ctx.get("directoryPicker") as DirectoryPicker | undefined; const capability = picker?.capability?.();
        if (!capability || capability.kind !== "native" || typeof capability.pick !== "function") throw new Error("picker-unavailable");
        selected = await capability.pick(signal);
      } else selected = await (this.#nativeFilePicker ?? { pick: (abort: AbortSignal) => pickNativeFile(abort, { defaultDirectory: located.root }) }).pick(signal);
      if (signal.aborted) { fail(res, 409, "picker-aborted"); return; }
      if (selected === null) { fail(res, 409, "picker-cancelled"); return; }
      const target = await normalizeNativePickedTarget(located.root, selected, kind); ok(res, target);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ""; const code = signal.aborted ? "picker-aborted" : PICKER_CODES.has(message) ? message : /unsupported|no supported|ENOENT|Cannot find (?:package|module)/i.test(message) ? "picker-unavailable" : "picker-failed";
      fail(res, code === "picker-failed" ? 500 : 409, code); return;
    }
  }
  private async retry(located: Located, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!["failed", "cancelled", "interrupted"].includes(located.job.status)) { fail(res, 409, "job-active"); return; }
    const engine = this.ctx.get("iciEngine") as Engine | undefined; if (!engine) { fail(res, 500, "storage-error"); return; }
    try { const result = await engine.explainPrepare({ workspaceId: located.job.workspaceId, query: located.job.apiName }, signal); if (!result.ok || result.value === undefined) { const code = result.error?.code ?? "storage-error"; fail(res, statusCode(code), code); return; } ok(res, { jobId: result.value.jobId, status: result.value.jobStatus, prepareArtifactPath: result.value.artifactPath }); }
    catch { fail(res, 500, "storage-error"); }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost"); const suffix = url.pathname.slice(EXPLAIN_ROUTES_PREFIX.length).replace(/^\//, ""); const parts = suffix.split("/").filter(Boolean); const action = parts[0] === "jobs" ? parts[2] : parts[1]; const jobId = parts[0] === "jobs" ? parts[1] : parts[0];
    if (!jobId || !action || !/^[a-f0-9]{16}$/.test(jobId)) { fail(res, 404, "job-missing"); return; }
    const located = await this.locate(jobId); if (!located) { fail(res, 404, "job-missing"); return; }
    if (req.method === "GET" && action === "status") { await this.getJob(located, res); return; }
    if (req.method === "GET" && action === "folder") { await this.folder(located, url, res); return; }
    if (req.method !== "POST" || !["confirm", "cancel", "retry", "native-pick"].includes(action) || req.headers["x-workbench-action"] !== "1") { response(res, 405, { ok: false, error: { code: "method-not-allowed", message: "method-not-allowed" } }); return; }
    if ((action === "confirm" || action === "native-pick") && typeof req.headers["content-type"] === "string" && !req.headers["content-type"].toLowerCase().startsWith("application/json")) { fail(res, 415, "confirmation-invalid"); return; }
    const controller = new AbortController(); req.on("aborted", () => controller.abort()); const body = await readBody(req); if (body === null) { fail(res, 413, "input-too-large"); return; }
    if (action === "confirm") { await this.confirm(located, body, res, controller.signal); return; }
    if (action === "native-pick") { await this.nativePick(located, body, res, controller.signal); return; }
    if (action === "cancel") { const scheduler = this.ctx.get("iciExplainScheduler") as Scheduler | undefined; const cancelled = scheduler ? await scheduler.cancelJob(jobId) : await updateJobRecord(located.root, jobId, located.job.revision, { status: "cancelled", error: "cancelled" }).then(() => true).catch(() => false); if (!cancelled) fail(res, 409, "revision-conflict"); else ok(res, { jobId, status: "cancelled" }); return; }
    await this.retry(located, res, controller.signal);
  }
}
