import { Component, type ReactNode } from "react";
import type { WorkbenchJobLocaleKey } from "./locales.ts";
import css from "./IciExplainToolview.module.css";

/** Running call: identity + raw arguments only (no result yet). */
type RunningBlock = { argsRaw?: string; call?: { argsRaw?: string } | null };
/** Settled call: the frozen result node, including its error surface. */
type SettledBlock = { kind: "tool-result"; call: { argsRaw?: string } | null; content: readonly { type?: string; text?: string }[]; isError?: boolean; error?: { readonly name?: string; readonly code?: string } };
type Block = RunningBlock | SettledBlock;
interface Props { readonly block: Block; readonly t: (key: WorkbenchJobLocaleKey) => string; }
interface Provider { readonly id: string; readonly models: readonly { id: string; name: string }[]; }
interface ReferenceTarget { readonly path: string; readonly kind: "none" | "file" | "directory"; }
/**
 * TASK-111: the Host ceiling plus this task's own live concurrency. `maxConcurrent`
 * stays the Host-wide value so the two ceilings are never conflated in the UI.
 */
interface SchedulerInfo { readonly maxConcurrent: number; readonly inFlight: number; readonly taskMaxConcurrent?: number; readonly taskInFlight?: number; readonly hostMaxConcurrent?: number }
interface Snapshot { job: { jobId: string; workspaceId: string; apiName: string; provider?: string | null; model?: string | null; folderPath?: string; referenceTarget?: ReferenceTarget; status: Status; revision: number; childSessionId?: string; startedAt?: string; finishedAt?: string; artifactPath?: string; error?: string; notBefore?: string }; referenceTarget?: ReferenceTarget; summary: { nodes: number; edges: number; sourceFiles: number; readableSources: number; sourceBytes: number; promptBaseBytes?: number; truncated: boolean }; providers: readonly Provider[]; scheduler?: SchedulerInfo }
interface BatchJob { jobId: string; apiName: string; status: Status; revision?: number; provider?: string | null; model?: string | null; childSessionId?: string; startedAt?: string; finishedAt?: string; artifactPath?: string; error?: string; promptBaseBytes?: number; sourceBytes?: number; }
interface BatchRecord { batchId: string; workspaceId: string; jobIds?: readonly string[]; jobCount?: number; createdAt: string; updatedAt: string; maxConcurrent?: number; requestedCount?: number; selector?: { kind?: string; label?: string } }
/** TASK-111 P4: the server pages the member list; the card renders exactly one page. */
interface PageInfo { readonly index: number; readonly size: number; readonly totalPages: number }
/** TASK-111: what the user asked for (one API / a list / a group / the whole workspace). */
function selectorLabel(batch: BatchRecord | undefined, t: Props["t"]): string { const kind = batch?.selector?.kind; if (kind === undefined) return ""; const label = batch?.selector?.label; return label === undefined || label === "" ? t("explain.selectorLabel") : label; }
interface BatchSnapshot { batch: BatchRecord; jobs: readonly BatchJob[]; providers: readonly Provider[]; scheduler?: SchedulerInfo; page?: PageInfo; summary: { promptBaseBytes: number; sourceBytes: number; maxPromptBaseBytes?: number; jobCount?: number; countsByStatus?: Record<string, number> }; }
type Status = "preparing" | "awaiting-input" | "scheduled" | "confirmed" | "running" | "final" | "failed" | "cancelled" | "interrupted";
/** TASK-111 runtime degradation of a card: a missing record or an unreachable Host stops silent polling. */
type Phase = "live" | "missing" | "unreachable";
interface CardState { readonly jobId?: string; readonly batchId?: string; readonly snapshot?: Snapshot; readonly batchSnapshot?: BatchSnapshot; readonly referenceTarget: ReferenceTarget; readonly provider: string; readonly model: string; readonly notBefore: string; readonly busy: boolean; readonly localError?: string; readonly page: number; readonly details: Record<string, boolean>; readonly capDraft: string; readonly capBusy: boolean; readonly capError?: string; readonly capSaved?: boolean; readonly phase: Phase }
const PREFIX = "/api/icomposer-workbench/ici/explain";
const PAGE_SIZE = 5;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 32;
const MAX_POLL_FAILURES = 5;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set<Status>(["awaiting-input", "scheduled", "confirmed", "running"]);
const RUNNING = new Set<Status>(["scheduled", "confirmed", "running"]);
const RETRYABLE = new Set<Status>(["failed", "cancelled", "interrupted"]);
const MAX_PROMPT_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".log"]);
function resultText(block: Block): string { return "kind" in block ? block.content.filter(item => item.type === "text").map(item => item.text ?? "").join("") : ""; }
function jobIdOf(block: Block): string | undefined { return resultText(block).match(/\bjob=([a-f0-9]{16})\b/)?.[1]; }
function batchIdOf(block: Block): string | undefined { return resultText(block).match(/\bbatch=([a-f0-9]{16})\b/)?.[1]; }
/** TASK-111: `concurrency=` reports the task-level `batch` setting; `batch=` stays the card identity token. */
function resultNumber(block: Block, key: string): number | undefined { const match = resultText(block).match(new RegExp(`\\b${key}=(\\d+)\\b`)); return match ? Number(match[1]) : undefined; }
function defaultModelOf(block: Block): { provider?: string; model?: string } { const match = resultText(block).match(/\bdefault=([^/\s]+)\/([^\s]+?)(?=(?:\.\s|[\s,;]|$))/); return match ? { provider: match[1], model: match[2] } : {}; }
/** Arguments of the call: the settled node backfills them, the running node still carries them. */
function callArgs(block: Block): Record<string, unknown> | undefined {
  const raw = ("kind" in block ? block.call?.argsRaw : block.argsRaw ?? block.call?.argsRaw);
  if (typeof raw !== "string" || raw === "") return undefined;
  try { const parsed: unknown = JSON.parse(raw); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
/** TASK-111: every target this call declared, so the preparing card can list what it is preparing. */
function declaredTargets(block: Block): readonly string[] | undefined {
  const args = callArgs(block);
  if (args === undefined) return undefined;
  if (Array.isArray(args.queries)) { const queries = args.queries.filter((item): item is string => typeof item === "string" && item.trim().length > 0); return queries.length > 0 ? queries : undefined; }
  return typeof args.query === "string" && args.query.trim().length > 0 ? [args.query] : undefined;
}
function declaredConcurrency(block: Block): number | undefined { const value = callArgs(block)?.concurrency; return typeof value === "number" && Number.isInteger(value) && value >= CONCURRENCY_MIN && value <= CONCURRENCY_MAX ? value : undefined; }
/**
 * TASK-111: a settled call that produced no task card must say so. The Host synthesizes
 * an empty interrupted result when a turn is aborted, and a failed prepare carries only
 * an `icomposer tools error:` text, so both are detected here instead of leaving the card
 * in a permanent "preparing" state.
 */
function settledFailure(block: Block): string | undefined {
  if (!("kind" in block)) return undefined;
  const text = resultText(block);
  const parsed = text.match(/icomposer tools error:\s*([A-Za-z0-9._-]+)/)?.[1];
  const code = typeof block.error?.code === "string" && block.error.code.length > 0 ? block.error.code : parsed;
  if (code !== undefined) return code;
  if (block.isError === true) return "model-failed";
  if (text.trim() === "") return "interrupted";
  return undefined;
}
function statusLabel(status: Status, t: Props["t"]): string { return typeof t === "function" ? t(`status.${status}` as WorkbenchJobLocaleKey) : status; }
function sessionShort(sessionId: string | undefined): string { return typeof sessionId === "string" && SESSION_RE.test(sessionId) ? sessionId.slice(0, 8) : ""; }
function formatTime(value: string | undefined): string { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return ""; try { return new Date(value).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }
function copySession(sessionId: string | undefined): void { if (!sessionId) return; try { void navigator.clipboard?.writeText(sessionId); } catch { /* clipboard unavailable */ } }
function byteSize(value: number): string { return `${(value / 1024).toFixed(value >= 1024 ? 1 : 0)} KiB`; }
function validRelativePath(path: unknown): path is string { return typeof path === "string" && path.length <= 512 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some(part => part === ".." || part === ".") && !path.startsWith(".metadata/"); }
function validReferenceTarget(value: unknown): value is ReferenceTarget { if (typeof value !== "object" || value === null) return false; const target = value as Record<string, unknown>; if (Object.keys(target).length !== 2) return false; if (target.kind === "none") return target.path === ""; if (!validRelativePath(target.path)) return false; if (target.kind === "directory") return true; if (target.kind !== "file") return false; const dot = target.path.lastIndexOf("."); return dot > 0 && TEXT_EXTENSIONS.has(target.path.slice(dot).toLowerCase()); }
function targetLabel(target: ReferenceTarget, t: Props["t"]): string { return target.kind === "none" ? t("explain.noReference") : target.kind === "file" ? t("explain.referenceFile") : t("explain.referenceDirectory"); }
const NONE_REFERENCE: ReferenceTarget = { path: "", kind: "none" } as const;
function targetPath(target: ReferenceTarget, t: Props["t"]): string { return target.kind === "none" ? "—" : target.path || t("explain.workspaceRoot"); }
function errorLabel(code: string | undefined, t: Props["t"]): string { switch (code) { case "picker-cancelled": return t("explain.pickerCancel"); case "picker-unavailable": return t("explain.pickerUnavailable"); case "picker-failed": return t("explain.pickerFailed"); case "picker-aborted": return t("explain.pickerAborted"); case "reference-outside-workspace": return t("explain.referenceOutsideWorkspace"); case "reference-symlink": return t("explain.referenceSymlink"); case "reference-unsupported": return t("explain.referenceUnsupported"); default: return t("explain.pickerFailed"); } }
/** A read outcome distinguishes "gone" from "unreachable" so the card can stop silent polling. */
type ReadOutcome<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "failed" };
async function readJson<T>(url: string, signal: AbortSignal): Promise<ReadOutcome<T>> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "failed" };
    const body = await response.json() as { ok?: boolean; result?: T };
    return body.ok === true && body.result !== undefined ? { kind: "ok", value: body.result } : { kind: "failed" };
  } catch { return { kind: "failed" }; }
}
async function getStatus(jobId: string, signal: AbortSignal): Promise<ReadOutcome<Snapshot>> { return readJson<Snapshot>(`${PREFIX}/jobs/${jobId}/status`, signal); }
async function getBatchStatus(batchId: string, page: number, signal: AbortSignal): Promise<ReadOutcome<BatchSnapshot>> { return readJson<BatchSnapshot>(`${PREFIX}/batches/${batchId}/status?page=${page}&size=${PAGE_SIZE}`, signal); }
async function postPath(path: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; result?: any; code?: string }> { try { const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Workbench-Action": "1", Accept: "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) }); const value = await response.json().catch(() => null) as { ok?: boolean; result?: any; error?: { code?: string } } | null; return value?.ok === true ? { ok: true, result: value.result } : { ok: false, code: value?.error?.code ?? "network" }; } catch { return { ok: false, code: "network" }; } }

export class IciExplainToolview extends Component<Props, CardState> {
  state: CardState;
  #controller?: AbortController;
  #poll?: ReturnType<typeof setInterval>;
  #pollKey?: string;
  #initializedJob?: string;
  #initializedBatch?: string;
  /** TASK-111: consecutive failed status reads; a persisted gap stops the poll instead of hiding it. */
  #failures = 0;
  #capInitialized = false;
  #capEdited = false;
  /** Monotonic edit stamp: a reply that lands after a newer keystroke must not replace the draft. */
  #capEditStamp = 0;
  /** TASK-102 P2-03: card identity epoch + settings request ownership, so a late reply never lands on another card. */
  #epoch = 0;
  #settingsController?: AbortController;
  #defaults: { readonly provider?: string; readonly model?: string };
  constructor(props: Props) { super(props); const jobId = jobIdOf(props.block); const batchId = batchIdOf(props.block); const defaults = defaultModelOf(props.block); this.#defaults = defaults; this.state = { jobId, batchId, referenceTarget: NONE_REFERENCE, provider: defaults.provider ?? "", model: defaults.model ?? "", notBefore: "", busy: false, page: 0, details: {}, capDraft: "", capBusy: false, phase: "live" }; }
  componentDidMount(): void { this.syncPolling(); }
  componentDidUpdate(previousProps: Props): void {
    const previousJobId = jobIdOf(previousProps.block);
    const previousBatchId = batchIdOf(previousProps.block);
    const nextJobId = jobIdOf(this.props.block);
    const nextBatchId = batchIdOf(this.props.block);
    if (nextJobId !== previousJobId || nextBatchId !== previousBatchId) {
      this.#defaults = defaultModelOf(this.props.block);
      this.#initializedJob = undefined;
      this.#initializedBatch = undefined;
      // A switched card is a fresh surface: any settings request owned by the
      // previous card loses authority, and every per-card draft resets.
      this.#epoch += 1;
      this.#settingsController?.abort();
      this.#settingsController = undefined;
      this.#capInitialized = false;
      this.#capEdited = false;
      this.#failures = 0;
      this.setState({ jobId: nextJobId, batchId: nextBatchId, snapshot: undefined, batchSnapshot: undefined, referenceTarget: NONE_REFERENCE, provider: this.#defaults.provider ?? "", model: this.#defaults.model ?? "", notBefore: "", busy: false, localError: undefined, page: 0, details: {}, capDraft: "", capBusy: false, capError: undefined, capSaved: undefined, phase: "live" }, this.syncPolling);
      return;
    }
    this.syncPolling();
  }
  componentWillUnmount(): void { this.#epoch += 1; this.#settingsController?.abort(); this.#settingsController = undefined; this.stopPolling(); }
  private text(key: WorkbenchJobLocaleKey): string { return typeof this.props.t === "function" ? this.props.t(key) : key; }
  private tpl(key: WorkbenchJobLocaleKey, value: string | number): string { const copy = this.text(key); return copy.includes("{}") ? copy.replace("{}", String(value)) : `${copy} ${value}`; }
  private isActive(): boolean { if (this.state.phase !== "live") return false; if (this.state.batchId) return this.state.batchSnapshot?.jobs.some(job => ACTIVE.has(job.status)) ?? true; return this.state.snapshot ? ACTIVE.has(this.state.snapshot.job.status) : true; }
  private pollingKey(): string | undefined { return this.state.batchId ? `batch:${this.state.batchId}` : this.state.jobId ? `job:${this.state.jobId}` : undefined; }
  private syncPolling = (): void => {
    const key = this.pollingKey();
    if (!key || !this.isActive()) { this.stopPolling(); return; }
    if (this.#pollKey !== key) {
      this.stopPolling();
      this.#pollKey = key;
      void this.refresh();
    }
    this.startPolling();
  };
  private startPolling(): void { if (this.#poll !== undefined) return; this.#poll = setInterval(() => { if (this.isActive()) void this.refresh(); }, 1000); }
  private stopPolling(): void { if (this.#poll !== undefined) { clearInterval(this.#poll); this.#poll = undefined; } this.#pollKey = undefined; this.#controller?.abort(); this.#controller = undefined; }
  private beginRefresh(force = false): AbortController | undefined { if (this.#controller !== undefined && !this.#controller.signal.aborted) { if (!force) return undefined; this.#controller.abort(); } const controller = new AbortController(); this.#controller = controller; return controller; }
  private async refresh(force = false): Promise<void> { if (this.state.batchId) return this.refreshBatchStatus(force); return this.refreshJobStatus(force); }
  /** Mark a card that can no longer be read: a missing record and a silent Host are both terminal for polling. */
  private degrade(phase: Phase): void { this.stopPolling(); if (this.state.phase !== phase) this.setState({ phase }); }
  private noteReadFailure(phase: Exclude<Phase, "live">, resume: boolean): void {
    this.#failures += 1;
    if (this.#failures >= MAX_POLL_FAILURES) this.degrade(phase);
    else if (resume) this.startPolling();
  }
  private noteReadSuccess(): void { this.#failures = 0; if (this.state.phase !== "live") this.setState({ phase: "live" }); }
  /** Manual re-check after a degraded card: clear the counters, resume the loop and refresh at once. */
  private reconnect = (): void => { this.#failures = 0; this.setState({ phase: "live" }, () => { void this.refresh(true); this.syncPolling(); }); };
  private async refreshJobStatus(force = false): Promise<void> {
    const jobId = this.state.jobId;
    if (!jobId) return;
    const controller = this.beginRefresh(force);
    if (!controller) return;
    try {
      const outcome = await getStatus(jobId, controller.signal);
      if (controller.signal.aborted || this.state.jobId !== jobId) return;
      if (outcome.kind === "missing") { this.degrade("missing"); return; }
      if (outcome.kind === "failed") { this.noteReadFailure("unreachable", false); return; }
      const next = outcome.value;
      this.noteReadSuccess();
      const first = this.#initializedJob !== jobId;
      this.#initializedJob = jobId;
      const capInit = this.initCapDraft(next.scheduler);
      this.setState(previous => { const candidate = next.job.referenceTarget ?? next.referenceTarget; const selectedTarget = validReferenceTarget(candidate) ? candidate : (typeof next.job.folderPath === "string" && next.job.folderPath !== "" && validReferenceTarget({ path: next.job.folderPath, kind: "directory" }) ? { path: next.job.folderPath, kind: "directory" as const } : NONE_REFERENCE); const initialProvider = next.job.provider ?? (previous.provider || next.providers[0]?.id || ""); const catalog = next.providers.find(item => item.id === initialProvider)?.models ?? []; const initialModel = next.job.model ?? (catalog.some(item => item.id === previous.model) ? previous.model : catalog[0]?.id ?? previous.model ?? ""); return { ...previous, ...capInit, snapshot: next, ...(first ? { referenceTarget: selectedTarget, provider: initialProvider, model: initialModel, notBefore: next.job.notBefore ? new Date(next.job.notBefore).toISOString().slice(0, 16) : "" } : {}) }; });
    } finally { if (this.#controller === controller) this.#controller = undefined; }
  }
  private async refreshBatchStatus(force = false): Promise<void> {
    const batchId = this.state.batchId;
    if (!batchId) return;
    const controller = this.beginRefresh(force);
    if (!controller) return;
    try {
      const outcome = await getBatchStatus(batchId, this.state.page + 1, controller.signal);
      if (controller.signal.aborted || this.state.batchId !== batchId) return;
      if (outcome.kind === "missing") { this.degrade("missing"); return; }
      if (outcome.kind === "failed") { this.noteReadFailure("unreachable", false); return; }
      const next = outcome.value;
      this.noteReadSuccess();
      const first = this.#initializedBatch !== batchId;
      this.#initializedBatch = batchId;
      const capInit = this.initCapDraft(next.scheduler, next.batch.maxConcurrent);
      this.setState(previous => { const seeded = previous.provider || this.#defaults.provider || ""; const initialProvider = next.jobs.find(job => job.provider)?.provider ?? (seeded || next.providers[0]?.id || ""); const catalog = next.providers.find(item => item.id === initialProvider)?.models ?? []; const storedModel = next.jobs.find(job => job.provider === initialProvider && job.model)?.model; const initialModel = storedModel ?? (catalog.some(item => item.id === previous.model) ? previous.model : catalog[0]?.id ?? previous.model ?? ""); return { ...previous, ...capInit, batchSnapshot: next, ...(first ? { provider: initialProvider, model: initialModel } : {}) }; });
    } finally { if (this.#controller === controller) this.#controller = undefined; }
  }
  private chooseProvider(provider: string): void { const selected = (this.state.snapshot?.providers ?? this.state.batchSnapshot?.providers ?? []).find(item => item.id === provider); const model = selected?.models[0]?.id ?? (provider === this.#defaults.provider ? this.#defaults.model ?? "" : ""); this.setState({ provider, model }); }
  private async pickReference(kind: "file" | "directory"): Promise<void> { const id = this.state.jobId ?? this.state.batchId; const scope = this.state.batchId ? "batches" : "jobs"; if (!id || this.state.busy) return; this.setState({ busy: true, localError: undefined }); const outcome = await postPath(`${PREFIX}/${scope}/${id}/native-pick`, { kind }); if (!outcome.ok) { this.setState({ busy: false, ...(outcome.code === "picker-cancelled" ? { localError: undefined } : { localError: outcome.code ?? "picker-failed" }) }); return; } const target = validReferenceTarget(outcome.result) ? outcome.result : undefined; if (!target) { this.setState({ busy: false, localError: "picker-failed" }); return; } this.setState({ busy: false, referenceTarget: target, localError: undefined }); }
  private async confirm(): Promise<void> { const { jobId, batchId, provider, model, referenceTarget, notBefore, snapshot, batchSnapshot } = this.state; const batchAwaiting = batchSnapshot?.jobs.filter(job => job.status === "awaiting-input") ?? []; const promptTooLarge = batchId ? batchAwaiting.some(job => (job.promptBaseBytes ?? 0) > MAX_PROMPT_BYTES) : (snapshot?.summary.promptBaseBytes ?? snapshot?.summary.sourceBytes ?? 0) > MAX_PROMPT_BYTES; const id = jobId ?? batchId; if (!id || !provider || !model || promptTooLarge || (batchId ? !batchSnapshot : !snapshot)) return; this.setState({ busy: true, localError: undefined }); let when: string; try { when = notBefore ? new Date(notBefore).toISOString() : new Date().toISOString(); } catch { this.setState({ busy: false, localError: "confirmation-invalid" }); return; } const scope = batchId ? "batches" : "jobs"; const outcome = await postPath(`${PREFIX}/${scope}/${id}/confirm`, { provider, model, referenceTarget, docs: [], notBefore: when, consent: true }); if (!outcome.ok) { this.setState({ busy: false, localError: outcome.code }); return; } if (batchId) { this.setState(previous => ({ ...previous, busy: false, batchSnapshot: previous.batchSnapshot ? { ...previous.batchSnapshot, jobs: previous.batchSnapshot.jobs.map(job => job.status === "awaiting-input" ? { ...job, status: "scheduled" as const, provider, model, notBefore: when } : job) } : undefined })); } else this.setState(previous => ({ ...previous, busy: false, snapshot: previous.snapshot ? { ...previous.snapshot, job: { ...previous.snapshot.job, status: "scheduled", provider, model, folderPath: referenceTarget.path, referenceTarget, notBefore: outcome.result.notBefore } } : undefined })); }
  private async cancel(): Promise<void> { const id = this.state.jobId ?? this.state.batchId; if (!id || this.state.busy) return; this.setState({ busy: true }); const scope = this.state.batchId ? "batches" : "jobs"; const outcome = await postPath(`${PREFIX}/${scope}/${id}/cancel`, {}); if (!outcome.ok) { this.setState({ busy: false, localError: outcome.code }); return; } if (this.state.batchId) this.setState(previous => ({ ...previous, busy: false, batchSnapshot: previous.batchSnapshot ? { ...previous.batchSnapshot, jobs: previous.batchSnapshot.jobs.map(job => ACTIVE.has(job.status) ? { ...job, status: "cancelled" as const } : job) } : undefined })); else this.setState(previous => ({ ...previous, busy: false, snapshot: previous.snapshot ? { ...previous.snapshot, job: { ...previous.snapshot.job, status: "cancelled" } } : undefined })); }
  private async retry(): Promise<void> { const id = this.state.jobId ?? this.state.batchId; if (!id || this.state.busy) return; this.setState({ busy: true, localError: undefined }); const scope = this.state.batchId ? "batches" : "jobs"; const outcome = await postPath(`${PREFIX}/${scope}/${id}/retry`, {}); if (!outcome.ok) { this.setState({ busy: false, localError: outcome.code ?? "network" }); return; } if (this.state.batchId) { this.setState({ busy: false }, () => { void this.refresh(true); }); return; } if (typeof outcome.result?.jobId !== "string") { this.setState({ busy: false, localError: "network" }); return; } this.#initializedJob = undefined; this.setState({ busy: false, jobId: outcome.result.jobId, snapshot: undefined, referenceTarget: NONE_REFERENCE, provider: "", model: "", notBefore: "", localError: undefined }, this.syncPolling); }
  private providers(): readonly Provider[] { return this.state.snapshot?.providers ?? this.state.batchSnapshot?.providers ?? []; }
  private renderRunMeta(t: Props["t"], meta: { provider?: string | null; model?: string | null; childSessionId?: string; startedAt?: string; finishedAt?: string }): ReactNode { const parts: string[] = []; if (meta.provider && meta.model) parts.push(`${meta.provider}/${meta.model}`); const started = formatTime(meta.startedAt); const finished = formatTime(meta.finishedAt); if (started) parts.push(`${t("explain.startedAt")} ${started}`); if (finished) parts.push(`${t("explain.finishedAt")} ${finished}`); const short = sessionShort(meta.childSessionId); return <p className={css.runMeta}>{parts.join(" · ")}{short ? <> · <code className={css.session} title={meta.childSessionId} onClick={() => copySession(meta.childSessionId)}>{t("explain.session")} {short}</code></> : null}</p>; }
  /** Initialize the task concurrency draft once; polling never overwrites a user draft. */
  private initCapDraft(scheduler: SchedulerInfo | undefined, taskMaxConcurrent?: number): Partial<CardState> { if (this.#capInitialized || this.#capEdited) return {}; const value = typeof taskMaxConcurrent === "number" ? taskMaxConcurrent : scheduler?.hostMaxConcurrent ?? scheduler?.maxConcurrent; if (typeof value !== "number") return {}; this.#capInitialized = true; return { capDraft: String(value) }; }
  /** Server pages are the only paging: the card asks for the page it shows. */
  private totalPages(snapshot: BatchSnapshot | undefined): number { if (snapshot === undefined) return 1; if (typeof snapshot.page?.totalPages === "number") return Math.max(1, snapshot.page.totalPages); const total = typeof snapshot.batch.jobCount === "number" ? snapshot.batch.jobCount : snapshot.jobs.length; return Math.max(1, Math.ceil(total / PAGE_SIZE)); }
  private gotoPage(next: number, snapshot: BatchSnapshot | undefined): void { const clamped = Math.max(1, Math.min(next, this.totalPages(snapshot))) - 1; if (clamped === this.state.page) return; // Per-row fold state is keyed by jobId and therefore survives a page change.
    this.setState({ page: clamped }, () => { void this.refresh(true); }); }
  private toggleDetails(key: string): void { this.setState(previous => ({ details: { ...previous.details, [key]: !previous.details[key] } })); }
  private elapsedText(job: { startedAt?: string; finishedAt?: string }): string { if (typeof job.startedAt !== "string" || Number.isNaN(Date.parse(job.startedAt))) return ""; const end = typeof job.finishedAt === "string" && !Number.isNaN(Date.parse(job.finishedAt)) ? Date.parse(job.finishedAt) : Date.now(); const seconds = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000)); const minutes = Math.floor(seconds / 60); return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
  /**
   * TASK-111: the task-level `batch` setting. It writes only this task's record, so
   * another task's setting and the durable Host ceiling are never touched; lowering
   * it cannot revoke jobs that already run and only gates the next starts.
   */
  private async applyConcurrency(): Promise<void> {
    const batchId = this.state.batchId;
    if (!batchId) return;
    const draft = this.state.capDraft.trim(); const value = /^\d+$/u.test(draft) ? Number(draft) : Number.NaN;
    if (!Number.isInteger(value) || value < CONCURRENCY_MIN || value > CONCURRENCY_MAX) { this.setState({ capError: "invalid", capSaved: false }); return; }
    const epoch = this.#epoch; const editStamp = this.#capEditStamp; const controller = new AbortController();
    this.#settingsController?.abort(); this.#settingsController = controller;
    const owns = (): boolean => this.#epoch === epoch && !controller.signal.aborted;
    this.setState({ capBusy: true, capError: undefined, capSaved: false });
    const outcome = await postPath(`${PREFIX}/batches/${batchId}/settings`, { maxConcurrent: value }, controller.signal);
    if (!owns()) return;
    if (this.#settingsController === controller) this.#settingsController = undefined;
    if (!outcome.ok) { this.setState({ capBusy: false, capError: outcome.code ?? "storage-error", capSaved: false }); return; }
    const applied = typeof outcome.result?.maxConcurrent === "number" ? outcome.result.maxConcurrent : value;
    // The save landed (server-committed settings are not rolled back), but a
    // newer keystroke owns the draft: show the receipt without replacing it.
    const keepDraft = this.#capEditStamp !== editStamp;
    if (keepDraft) this.setState({ capBusy: false, capError: undefined, capSaved: true });
    else this.setState({ capBusy: false, capDraft: String(applied), capError: undefined, capSaved: true });
    void this.refresh(true);
  }
  /** Editable task row: how many targets of THIS task may be analyzed at once. */
  private renderTaskConcurrency(t: Props["t"], batch: BatchRecord, scheduler: SchedulerInfo | undefined): ReactNode {
    const host = scheduler?.hostMaxConcurrent ?? scheduler?.maxConcurrent;
    const taskMax = scheduler?.taskMaxConcurrent ?? batch.maxConcurrent ?? host;
    const inTask = scheduler?.taskInFlight ?? 0;
    const over = typeof taskMax === "number" && inTask > taskMax;
    return <div className={css.scheduler} data-testid="ici-explain-task-concurrency"><label className={css.field}><span>{t("explain.taskConcurrency")}</span><input type="number" min={CONCURRENCY_MIN} max={CONCURRENCY_MAX} step={1} value={this.state.capDraft} disabled={this.state.capBusy} onChange={event => { this.#capEdited = true; this.#capEditStamp += 1; this.setState({ capDraft: event.target.value, capSaved: false }); }} /><button type="button" disabled={this.state.capBusy} onClick={() => void this.applyConcurrency()}>{t("explain.concurrencyApply")}</button></label><p className={css.hint} data-testid="ici-explain-task-concurrency-hint">{this.tpl("explain.taskConcurrencyHint", typeof host === "number" ? host : "—")}</p><p className={css.hint}>{t("explain.taskInFlight")} {inTask}{typeof taskMax === "number" ? ` / ${t("explain.limit")} ${taskMax}` : ""}{typeof host === "number" ? ` · ${t("explain.hostLimit")} ${host}` : ""}</p>{over ? <p className={css.hint} role="status">{t("explain.overCapacity")}</p> : null}{this.state.capError ? <p className={css.error} role="alert">{this.state.capError === "invalid" ? t("explain.concurrencyInvalid") : t("explain.concurrencyFailed")}</p> : null}{this.state.capSaved ? <p className={css.hint} role="status">{t("explain.concurrencySaved")}</p> : null}</div>;
  }
  /** TASK-111: a single-API job has no task of its own; its Host ceiling is read-only. */
  private renderHostConcurrency(t: Props["t"], scheduler: SchedulerInfo | undefined): ReactNode { const host = scheduler?.hostMaxConcurrent ?? scheduler?.maxConcurrent; const inFlight = scheduler?.inFlight ?? 0; return <div className={css.scheduler} data-testid="ici-explain-host-concurrency"><p className={css.hint}>{t("explain.concurrency")} · {t("explain.hostLimit")} {typeof host === "number" ? host : "—"} · {t("explain.inFlight")} {inFlight}</p><p className={css.hint}>{t("explain.concurrencyHint")}</p></div>; }
  private renderPagination(t: Props["t"], snapshot: BatchSnapshot | undefined): ReactNode { const total = this.totalPages(snapshot); if (total <= 1) return null; const current = Math.min(this.state.page, total - 1) + 1; return <div className={css.pagination}><button type="button" disabled={current <= 1} onClick={() => this.gotoPage(current - 1, snapshot)}>{t("explain.prevPage")}</button><span>{t("explain.pageLabel")} {current}/{total}</span><button type="button" disabled={current >= total} onClick={() => this.gotoPage(current + 1, snapshot)}>{t("explain.nextPage")}</button></div>; }
  private renderBatchStats(t: Props["t"], jobs: readonly BatchJob[], snapshot: BatchSnapshot | undefined): ReactNode { const byStatus = snapshot?.summary.countsByStatus; const at = (status: string): number => byStatus === undefined ? jobs.filter(job => job.status === status).length : (byStatus[status] ?? 0); const jobTotal = typeof snapshot?.summary.jobCount === "number" ? snapshot.summary.jobCount : jobs.length; return <p className={css.batchStats} data-testid="ici-explain-batch-stats">{t("explain.jobTotal")} {jobTotal} · {t("explain.statFinal")} {at("final")} · {t("explain.statRunning")} {at("running")} · {t("explain.statWaiting")} {at("scheduled") + at("confirmed")} · {statusLabel("awaiting-input", t)} {at("awaiting-input")} · {t("explain.statFailed")} {at("failed")} · {t("explain.statCancelled")} {at("cancelled") + at("interrupted")}</p>; }
  private renderBatchJobRow(t: Props["t"], job: BatchJob): ReactNode { const key = `job:${job.jobId}`; const open = this.state.details[key] === true; const elapsed = this.elapsedText(job); const shortError = job.error === undefined ? "" : job.error.length > 60 ? `${job.error.slice(0, 60)}…` : job.error; return <li key={job.jobId} className={css.batchJobRow}><div className={css.jobLine}><strong className={css.jobName}>{job.apiName}</strong> · {statusLabel(job.status, t)}{elapsed ? ` · ${t("explain.elapsed")} ${elapsed}` : ""}{shortError ? <> · <span className={css.errorText} title={job.error}>{shortError}</span></> : null}<button type="button" className={css.detailsToggle} onClick={() => this.toggleDetails(key)}>{open ? t("explain.hideDetails") : t("explain.details")}</button></div>{open ? <div className={css.detailsBody}>{this.renderRunMeta(t, job)}{job.artifactPath ? <p className={css.path}>{t("explain.complete")}: <code>{job.artifactPath}</code></p> : null}{job.error ? <p className={css.error}>{job.error}</p> : null}</div> : null}</li>; }
  private clearReference(): void { if (this.state.busy) return; this.setState({ referenceTarget: NONE_REFERENCE, localError: undefined }); }
  private renderConfirmation(t: Props["t"], batch: boolean): ReactNode { const { referenceTarget, provider, model, notBefore, busy, localError, snapshot, batchSnapshot } = this.state; const providers = this.providers(); const models = providers.find(item => item.id === provider)?.models ?? []; const promptBytes = batch ? (batchSnapshot?.summary.promptBaseBytes ?? 0) : (snapshot?.summary.promptBaseBytes ?? snapshot?.summary.sourceBytes ?? 0); const awaiting = batchSnapshot?.jobs.filter(job => job.status === "awaiting-input") ?? []; const promptTooLarge = batch ? awaiting.some(job => (job.promptBaseBytes ?? 0) > MAX_PROMPT_BYTES) : promptBytes > MAX_PROMPT_BYTES; return <><p className={css.consent}>{t("explain.consent")}</p>{batch ? <p className={css.hint}>{t("explain.appliesToTask")}</p> : null}<fieldset className={css.fieldset}><legend>{t("explain.referenceTarget")}</legend><p className={css.selectedReference}>{t("explain.selectedReference")}: <code>{targetPath(referenceTarget, t)}</code> · {targetLabel(referenceTarget, t)}</p><p className={css.hint}>{t("explain.workspaceOnlyHint")}</p><div className={css.referenceActions}><button type="button" disabled={busy || referenceTarget.kind === "none"} onClick={() => this.clearReference()}>{t("explain.noReference")}</button><button type="button" disabled={busy} onClick={() => void this.pickReference("file")}>{t("explain.chooseFile")}</button><button type="button" disabled={busy} onClick={() => void this.pickReference("directory")}>{t("explain.chooseDirectory")}</button></div></fieldset><label className={css.field}><span>{t("explain.provider")}</span><select value={provider} disabled={busy} onChange={event => this.chooseProvider(event.target.value)}><option value="">{t("explain.choose")}</option>{providers.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label className={css.field}><span>{t("explain.model")}</span>{models.length > 0 ? <select value={model} disabled={busy} onChange={event => this.setState({ model: event.target.value })}><option value="">{t("explain.choose")}</option>{models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select> : <><input value={model} disabled={busy} onChange={event => this.setState({ model: event.target.value })} /><span className={css.hint}>{t("explain.customModelHint")}</span></>}</label><label className={css.field}><span>{t("explain.earliest")}</span><input type="datetime-local" value={notBefore} disabled={busy} onChange={event => this.setState({ notBefore: event.target.value })} /><button type="button" disabled={busy} onClick={() => this.setState({ notBefore: "" })}>{t("explain.now")}</button></label><p className={css.hint}>{t("explain.notBeforeHint")} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</p><p className={css.usage}>{t(batch ? "explain.batchUsage" : "explain.usage")}: {byteSize(promptBytes)} / 256 KiB{batch ? ` · ${t("explain.batchPerJobLimit")}` : ""}{promptTooLarge ? ` · ${t("explain.inputTooLarge")}` : ""}</p>{promptTooLarge ? <p className={css.error} role="alert">{t(batch ? "explain.batchTooLarge" : "explain.promptTooLarge")}</p> : null}{localError ? <p className={css.error} role="alert">{errorLabel(localError, t)}</p> : null}<div className={css.actions}><button type="button" title={promptTooLarge ? t(batch ? "explain.batchTooLarge" : "explain.promptTooLarge") : undefined} disabled={busy || !provider || !model || promptTooLarge} onClick={() => void this.confirm()}>{snapshot?.job.status === "scheduled" && !batch ? t("explain.update") : t("explain.start")}</button><button type="button" disabled={busy} onClick={() => void this.cancel()}>{t(batch ? "explain.batchCancelAll" : "explain.cancel")}</button></div></> }
  private renderBatch(t: Props["t"]): ReactNode {
    const batch = this.state.batchSnapshot;
    const jobs = batch?.jobs ?? [];
    const status = batch ? batchStatus(jobs) : "preparing";
    const awaiting = jobs.filter(job => job.status === "awaiting-input");
    const confirmable = awaiting.length > 0 && jobs.every(job => job.status === "awaiting-input" || job.status === "final");
    const retryable = jobs.some(job => RETRYABLE.has(job.status)) && !jobs.some(job => RUNNING.has(job.status));
    // The server returns exactly the page this card shows (bounded request and I/O).
    const pageJobs = jobs;
    const requested = batch?.batch.requestedCount;
    const selector = selectorLabel(batch?.batch, t);
    const totalTargets = typeof batch?.batch.jobCount === "number" ? batch.batch.jobCount : jobs.length;
    return <Card title={`${t("explain.batchTitle")} · ${totalTargets} ${t("explain.batchApis")}`} status={status} t={t}>{batch?.batch.selector ? <p className={css.hint} data-testid="ici-explain-task-selector">{t("explain.taskSelector")}: <strong>{batch.batch.selector.kind}</strong>{selector ? ` · ${selector}` : ""}</p> : null}<p className={css.summary}>{t("explain.batchList")}: {jobs.length} {t("explain.batchApis")}{typeof requested === "number" && requested > jobs.length ? ` · ${t("explain.targetsTotal")} ${requested} · ${t("explain.uniqueTargets")} ${jobs.length}` : ""}</p>{batch ? this.renderBatchStats(t, jobs, batch) : null}{batch ? this.renderTaskConcurrency(t, batch.batch, batch.scheduler) : null}<ul className={css.hint} data-testid="ici-explain-batch-jobs">{pageJobs.map(job => this.renderBatchJobRow(t, job))}</ul>{this.renderPagination(t, batch)}{batch ? <p className={css.hint}>{t("explain.batchOpsScope")}</p> : null}{batch && confirmable ? this.renderConfirmation(t, true) : null}{batch && !confirmable && !retryable && RUNNING.has(status) ? <><p className={css.progress} role="status">{status === "scheduled" ? `${statusLabel(status, t)} · ${t("explain.waitingIdle")}` : `${statusLabel(status, t)} · ${t("explain.runningNow")}`}</p><button type="button" disabled={this.state.busy} onClick={() => void this.cancel()}>{t("explain.batchCancelAll")}</button></> : null}{batch && status === "final" ? <p className={css.done} role="status">{t("explain.complete")}</p> : null}{batch && retryable ? <><p className={css.error} role="alert">{t("explain.batchFailed")}</p><button type="button" disabled={this.state.busy} onClick={() => void this.retry()}>{t("explain.batchRetryFailed")}</button></> : null}{!batch ? <><p className={css.progress}>{t("explain.prepareWaiting")}</p><p className={css.hint}>{t("explain.loadingTask")}</p></> : null}</Card>;
  }
  /** Running call: say what is being prepared and which targets, never "waiting for confirmation". */
  private renderPreparing(t: Props["t"]): ReactNode {
    const targets = declaredTargets(this.props.block) ?? [];
    const concurrency = declaredConcurrency(this.props.block);
    const targetPages = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
    const page = Math.min(this.state.page + 1, targetPages) - 1;
    const pageTargets = targets.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const title = targets.length > 0 ? `${t("explain.batchTitle")} · ${targets.length} ${t("explain.batchApis")}` : t("explain.title");
    return <Card title={title} status="preparing" t={t}><p className={css.progress} data-testid="ici-explain-preparing">{this.tpl("explain.preparingCount", targets.length)}</p><p className={css.hint}>{t("explain.prepareWaiting")}</p>{targets.length > 0 ? <><ul className={css.hint} data-testid="ici-explain-preparing-targets">{pageTargets.map(name => <li key={name} className={css.batchJobRow}>{name}</li>)}</ul>{targetPages > 1 ? <div className={css.pagination}><button type="button" disabled={page <= 0} onClick={() => this.setState({ page: page - 1 })}>{t("explain.prevPage")}</button><span>{t("explain.pageLabel")} {page + 1}/{targetPages}</span><button type="button" disabled={page >= targetPages - 1} onClick={() => this.setState({ page: page + 1 })}>{t("explain.nextPage")}</button></div> : null}</> : null}{typeof concurrency === "number" ? <p className={css.hint}>{t("explain.taskConcurrency")} {concurrency} · {t("explain.concurrencyHint")}</p> : null}</Card>;
  }
  private renderDegraded(t: Props["t"], phase: Exclude<Phase, "live">): ReactNode {
    const title = this.state.batchId || this.state.jobId ? t("explain.batchTitle") : t("explain.title");
    return <Card title={title} status="failed" t={t}><p className={css.error} role="alert">{phase === "missing" ? t("explain.recordMissing") : t("explain.unreachable")}</p><p className={css.hint}>{phase === "missing" ? t("explain.recordMissingHint") : t("explain.unreachableHint")}</p>{phase === "unreachable" ? <div className={css.actions}><button type="button" onClick={this.reconnect}>{t("explain.reconnect")}</button></div> : null}</Card>;
  }
  render(): ReactNode {
    const t = this.text.bind(this);
    const failure = settledFailure(this.props.block);
    if (failure !== undefined) return <Card title={t("explain.title")} status="failed" t={t}><p className={css.error} role="alert" data-testid="ici-explain-prepare-failed">{t("explain.prepareFailed")} · {t("explain.errorCode")} {failure}</p><p className={css.hint}>{t("explain.prepareFailedHint")}</p></Card>;
    if (this.state.phase !== "live") return this.renderDegraded(t, this.state.phase);
    if (this.state.batchId) return this.renderBatch(t);
    const { snapshot, jobId } = this.state;
    if (!jobId) return this.renderPreparing(t);
    const status: Status = snapshot?.job.status ?? "preparing";
    const metaOpen = this.state.details["job:meta"] === true;
    return <Card title={snapshot?.job.apiName ?? t("explain.title")} status={status} t={t}>{snapshot ? <p className={css.summary}>{snapshot.summary.nodes} {t("explain.nodes")} · {snapshot.summary.sourceFiles} {t("explain.sources")} · {snapshot.summary.readableSources} {t("explain.readable")}</p> : null}{snapshot ? this.renderHostConcurrency(t, snapshot.scheduler) : null}{snapshot ? <button type="button" className={css.detailsToggle} onClick={() => this.toggleDetails("job:meta")}>{metaOpen ? t("explain.hideDetails") : t("explain.details")}</button> : null}{snapshot && metaOpen ? <div className={css.detailsBody}>{this.renderRunMeta(t, snapshot.job)}{snapshot.job.artifactPath ? <p className={css.path}>{t("explain.complete")}: <code>{snapshot.job.artifactPath}</code></p> : null}{snapshot.job.error ? <p className={css.error}>{snapshot.job.error}</p> : null}</div> : null}{snapshot?.summary.truncated ? <p className={css.hint}>{t("explain.truncated")}</p> : null}{status === "awaiting-input" || status === "scheduled" ? this.renderConfirmation(t, false) : null}{status === "confirmed" || status === "running" ? <><p className={css.progress} role="status">{status === "confirmed" ? `${statusLabel(status, t)} · ${t("explain.waitingIdle")}` : `${statusLabel(status, t)} · ${t("explain.runningNow")}`}</p><button type="button" disabled={this.state.busy} onClick={() => void this.cancel()}>{t("explain.cancel")}</button></> : null}{status === "final" ? <p className={css.done} role="status">{t("explain.complete")}: <code className={css.path}>{snapshot?.job.artifactPath ?? "—"}</code></p> : null}{status === "failed" || status === "cancelled" || status === "interrupted" ? <><p className={css.error} role="alert">{this.state.localError ?? snapshot?.job.error ?? statusLabel(status, t)}</p><button type="button" disabled={this.state.busy} onClick={() => void this.retry()}>{t("explain.retry")}</button></> : null}</Card>;
  }
}
function batchStatus(jobs: readonly BatchJob[]): Status { if (jobs.some(job => job.status === "running")) return "running"; if (jobs.some(job => job.status === "scheduled" || job.status === "confirmed")) return "scheduled"; if (jobs.some(job => job.status === "failed")) return "failed"; if (jobs.some(job => job.status === "interrupted")) return "interrupted"; if (jobs.some(job => job.status === "awaiting-input")) return "awaiting-input"; if (jobs.some(job => job.status === "cancelled")) return "cancelled"; return "final"; }
function Card({ title, status, t, children }: { title: string; status: Status; t: Props["t"]; children: ReactNode }): ReactNode { return <section className={css.card} data-job-status={status} data-testid="ici-explain-card"><header className={css.header}><strong>{title}</strong><span className={css.status}>{statusLabel(status, t)}</span></header>{children}</section>; }
