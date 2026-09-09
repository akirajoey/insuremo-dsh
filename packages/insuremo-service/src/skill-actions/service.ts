import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import { failureDiagnosis } from "../diagnosis.ts";
import { digest, runCaptureDetailed } from "../run.ts";
import type { ImoSkillActivation, ImoSkillActivationSnapshot, SkillActivationController } from "../skill-activation.ts";
import { skillActivationControllerFor } from "../skill-activation.ts";
import type { ImoSkills } from "../skills.ts";
import type { OperationLogLike } from "../operation-log-face.ts";
import { invalidateInsuremoSkillCatalog } from "../skill-provider.ts";
import { diffInventory } from "./diff.ts";
import { buildSkillReceipt, type SkillReceiptInput } from "./finalize.ts";
import { ExecutionJournal, type ExecutionJournalEntry } from "./execution-journal.ts";
import { recoverInventory, type RecoveryReport } from "./recovery.ts";
import { actionCommand, executionArgs, previewSkillAction, skillCatalogArgs, skillDiagnosisOperation, SKILLS_TOOL_COMMAND } from "./preview.ts";
import {
  buildSkillCatalog,
  catalogSkillNames,
  isEmptySkillCatalogOutput,
  parseSkillCatalogOutput,
  SKILL_CATALOG_TIMEOUT_MS,
  SKILLS_TOOL_SOURCE,
  type SkillCatalogSnapshot,
} from "./catalog.ts";
import { installSourceProvenance, normalizeSkillAction, skillActionParamsDigest } from "./validation.ts";
import {
  SKILL_ACTION_COMPLETED_EVENT,
  SKILL_ACTION_FAILED_EVENT,
  SKILL_ACTIVATION_KIND,
  SKILL_INSTALL_KIND,
  SKILL_REMOVE_KIND,
  SKILL_UPDATE_KIND,
  type ImoSkillActions, type NormalizedSkillAction, type PendingSkillAction,
  type SkillActionConfig, type SkillActionError, type SkillActionEvent,
  type SkillActionExecution, type SkillActionInput, type SkillActionReceipt,
  type SkillActionRequest, type SkillActionResult, type SkillActionStatus,
  type SkillInventorySnapshot,
} from "./types.ts";

const EMPTY_DIGEST = digest("");
const EMPTY_DIFF = Object.freeze({ added: [], removed: [], updated: [] });
const MAX_CATALOG_CACHE_KEYS = 4;

/** Approval-gated global IMO Skills install/update/remove/activation actions. */
interface SkillActionsState {
  pending: Map<string, PendingSkillAction>;
  journal: ExecutionJournal;
  running: { operationId: string; kind: PendingSkillAction["kind"] } | null;
  disposed: boolean;
}
interface CatalogFlight {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<SkillActionResult<SkillCatalogSnapshot>>;
  waiters: number;
}
let skillActionsStateSlot: SkillActionsState | undefined;
function skillActionsStateFor(_receiver: unknown): SkillActionsState {
  if (skillActionsStateSlot === undefined) throw new Error("skill actions state uninitialized");
  return skillActionsStateSlot;
}

export class ImoSkillActionsService extends Service implements ImoSkillActions {
  static inject = ["imoSkills", "imoSkillActivation", "operationLog", "subprocess"];
  static Config = Config;

  #config: SkillActionConfig;
  #skills: ImoSkills;
  #activation: ImoSkillActivation;
  #controller: SkillActivationController | undefined;
  #operationLog: OperationLogLike;
  #catalogCache = new Map<string, { readonly snapshot: SkillCatalogSnapshot; readonly expiresAtMs: number }>();
  #catalogInFlight = new Map<string, CatalogFlight>();

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoSkillActions");
    const resolved = resolveConfig(config);
    this.#config = { command: resolved.command, timeoutMs: resolved.skillActionTimeoutMs, allowedGitHosts: resolved.allowedGitHosts };
    this.#skills = ctx.get<ImoSkills>("imoSkills")!;
    this.#activation = ctx.get<ImoSkillActivation>("imoSkillActivation")!;
    this.#controller = skillActivationControllerFor(this.#activation);
    skillActionsStateSlot = {
      pending: new Map<string, PendingSkillAction>(),
      journal: new ExecutionJournal(),
      running: null,
      disposed: false,
    };
    this.#operationLog = ctx.get<OperationLogLike>("operationLog")!;
    this.request = this.request.bind(this);
    this.execute = this.execute.bind(this);
    this.getCatalog = this.getCatalog.bind(this);
    this.refreshCatalog = this.refreshCatalog.bind(this);
    this.installCatalogSkill = this.installCatalogSkill.bind(this);
    this.runDirect = this.runDirect.bind(this);
    this.status = this.status.bind(this);
    // Keep the long-standing face's own-key surface stable for existing
    // consumers. Catalog capabilities live on a private prototype so legacy
    // reflection cannot mistake them for action kinds while routes can still
    // call the typed methods normally.
    const catalogFace = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(catalogFace, {
      getCatalog: { value: (signal?: AbortSignal) => this.getCatalog(signal), enumerable: false },
      refreshCatalog: { value: (signal?: AbortSignal, force?: boolean) => this.refreshCatalog(signal, force), enumerable: false },
      installCatalogSkill: { value: (name: string, signal?: AbortSignal) => this.installCatalogSkill(name, signal), enumerable: false },
    });
    Object.freeze(catalogFace);
    const face = Object.assign(Object.create(catalogFace), {
      request: (input: SkillActionInput, signal?: AbortSignal) => this.request(input, signal),
      execute: (operationId: string, signal?: AbortSignal) => this.execute(operationId, signal),
      runDirect: (input: SkillActionInput, signal?: AbortSignal) => this.runDirect(input, signal),
      status: () => this.status(),
    }) as ImoSkillActions;
    ctx.set("imoSkillActions", Object.freeze(face));
    this.ctx.effect(() => () => {
      skillActionsStateFor(this).disposed = true;
      skillActionsStateFor(this).pending.clear();
      skillActionsStateFor(this).journal.clear();
      skillActionsStateFor(this).running = null;
      this.#catalogCache.clear();
      for (const flight of this.#catalogInFlight.values()) flight.controller.abort();
      this.#catalogInFlight.clear();
    }, "imoSkillActions.state");
  }

  /**
   * Cache-only catalog read. This is intentionally separate from refresh so a
   * browser GET cannot make npx download/execute a package or contact a
   * registry implicitly.
   */
  async getCatalog(signal?: AbortSignal): Promise<SkillActionResult<SkillCatalogSnapshot>> {
    if (signal?.aborted) return resultFailure("cancelled", "Skills catalog read was cancelled");
    if (skillActionsStateFor(this).disposed) return resultFailure("service-disposed", "IMO skill action service is disposed");
    const cached = this.#catalogCache.get(this.catalogCacheKey());
    if (cached !== undefined && cached.expiresAtMs > Date.now()) return { ok: true, value: cached.snapshot };
    return resultFailure("catalog-unavailable", "the trusted Skills catalog is unavailable; refresh it explicitly");
  }

  /** Explicit, bounded/coalesced source discovery used by the UI refresh action. */
  async refreshCatalog(signal?: AbortSignal, force = true): Promise<SkillActionResult<SkillCatalogSnapshot>> {
    if (skillActionsStateFor(this).running !== null) return resultFailure("busy", "another skill action is already running");
    return this.loadCatalog(signal, force);
  }

  /**
   * Single-skill install face. The exact name must be present in a fresh
   * server-side catalog before any install preview or mutation is spawned.
   */
  async installCatalogSkill(name: string, signal?: AbortSignal): Promise<SkillActionExecution> {
    if (signal?.aborted) return executionFailure("cancelled", "skill install was cancelled");
    if (!isSkillName(name)) return executionFailure("invalid-skill-name", "skill name is invalid");
    // Keep scenario and single-skill argv paths separate. This fixed source is
    // the only alias that action code may translate to skills-tool here. The
    // runDirect kernel performs the catalog check after taking its busy lock.
    return this.runDirect({
      kind: SKILL_INSTALL_KIND,
      source: { type: "alias", value: SKILLS_TOOL_SOURCE },
      agent: "universal",
      skills: [name],
    }, signal);
  }

  private async loadCatalog(signal: AbortSignal | undefined, force: boolean): Promise<SkillActionResult<SkillCatalogSnapshot>> {
    if (signal?.aborted) return resultFailure("cancelled", "Skills catalog read was cancelled");
    if (skillActionsStateFor(this).disposed) return resultFailure("service-disposed", "IMO skill action service is disposed");
    const key = this.catalogCacheKey();
    const cached = this.#catalogCache.get(key);
    if (!force && cached !== undefined && cached.expiresAtMs > Date.now()) return { ok: true, value: cached.snapshot };
    // Concurrent opens/refreshes share one bounded process. Each caller gets
    // an abortable view of that process; cancelling one request never cancels
    // another request that joined the same trusted-source flight.
    let flight = this.#catalogInFlight.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = this.fetchCatalog(controller.signal, key).catch(() => resultFailure("catalog-unavailable", "the trusted Skills catalog is unavailable"));
      flight = { key, controller, promise, waiters: 0 };
      this.#catalogInFlight.set(key, flight);
      void promise.finally(() => {
        if (this.#catalogInFlight.get(key) === flight) this.#catalogInFlight.delete(key);
      }).catch(() => undefined);
    }
    return this.awaitCatalogFlight(flight, signal);
  }

  private async awaitCatalogFlight(flight: CatalogFlight, signal?: AbortSignal): Promise<SkillActionResult<SkillCatalogSnapshot>> {
    flight.waiters += 1;
    try {
      if (signal === undefined) return await flight.promise;
      if (signal.aborted) return resultFailure("cancelled", "Skills catalog read was cancelled");
      return await new Promise<SkillActionResult<SkillCatalogSnapshot>>(resolve => {
        let settled = false;
        const finish = (value: SkillActionResult<SkillCatalogSnapshot>) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => finish(resultFailure("cancelled", "Skills catalog read was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        void flight.promise.then(finish, () => finish(resultFailure("catalog-unavailable", "the trusted Skills catalog is unavailable")));
      });
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && this.#catalogInFlight.get(flight.key) === flight) flight.controller.abort();
    }
  }

  private catalogCacheKey(): string {
    // The skills-tool resolves its config/store from the process home. Keep
    // distinct isolated homes from sharing either a whitelist or a flight;
    // this key never leaves the Host process.
    return process.env.HOME ?? process.env.USERPROFILE ?? "<default-home>";
  }

  private async fetchCatalog(signal: AbortSignal | undefined, cacheKey: string): Promise<SkillActionResult<SkillCatalogSnapshot>> {
    const run = await runCaptureDetailed(this.ctx.subprocess, {
      command: SKILLS_TOOL_COMMAND,
      args: skillCatalogArgs(),
      timeoutMs: Math.min(this.#config.timeoutMs, SKILL_CATALOG_TIMEOUT_MS),
      signal,
      // clack's spinner writes to stdout. CI + no-color makes the known 1.1.2
      // envelope deterministic; the parser still accepts ANSI when a runtime
      // ignores these hints and fails closed on all other structure.
      env: { CI: "true", FORCE_COLOR: "0", TERM: "dumb" },
    });
    if (!run.ok) {
      const emptyOutput = run.error.code === "non-zero-exit" && isEmptySkillCatalogOutput(run.detail?.stdout ?? "");
      if (!emptyOutput) return resultFailure("catalog-unavailable", "the trusted Skills catalog is unavailable");
      const snapshot = buildSkillCatalog({ skills: [], foundCount: 0 });
      this.cacheCatalog(cacheKey, snapshot);
      return { ok: true, value: snapshot };
    }
    if (run.value.stdout.truncated) return resultFailure("catalog-unavailable", "the trusted Skills catalog is unavailable");
    const parsed = parseSkillCatalogOutput(run.value.stdout.text);
    if (!parsed.ok) {
      return resultFailure("catalog-unavailable", "the trusted Skills catalog could not be verified");
    }
    const snapshot = buildSkillCatalog(parsed.value);
    this.cacheCatalog(cacheKey, snapshot);
    return { ok: true, value: snapshot };
  }

  private cacheCatalog(cacheKey: string, snapshot: SkillCatalogSnapshot): void {
    this.#catalogCache.delete(cacheKey);
    this.#catalogCache.set(cacheKey, { snapshot, expiresAtMs: Date.parse(snapshot.expiresAt) });
    while (this.#catalogCache.size > MAX_CATALOG_CACHE_KEYS) {
      const oldest = this.#catalogCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#catalogCache.delete(oldest);
    }
  }

  private async validateCatalogInstall(action: NormalizedSkillAction, signal?: AbortSignal): Promise<SkillActionResult<NormalizedSkillAction>> {
    if (action.kind !== SKILL_INSTALL_KIND || action.source.type !== "alias" || action.source.value !== SKILLS_TOOL_SOURCE) {
      return { ok: true, value: action };
    }
    if (action.skills.length !== 1) return resultFailure("catalog-selection-invalid", "exactly one catalog Skill must be selected");
    const catalog = await this.loadCatalog(signal, false);
    if (!catalog.ok) return catalog;
    const known = new Set(catalogSkillNames(catalog.value));
    if (action.skills.some(name => !known.has(name))) {
      return resultFailure("catalog-selection-invalid", "the selected Skill is not in the current trusted catalog");
    }
    return { ok: true, value: action };
  }

  async request(input: SkillActionInput, signal?: AbortSignal): Promise<SkillActionResult<SkillActionRequest>> {
    if (signal?.aborted) return resultFailure("cancelled", "skill action request was cancelled");
    if (skillActionsStateFor(this).disposed) return resultFailure("service-disposed", "IMO skill action service is disposed");
    const normalized = normalizeSkillAction(input, this.#config.allowedGitHosts);
    if (!normalized.ok) return normalized;
    const catalogValidated = await this.validateCatalogInstall(normalized.value, signal);
    if (!catalogValidated.ok) return catalogValidated;
    const action = catalogValidated.value;
    const preview = await previewSkillAction(this.ctx, this.#skills, this.#activation, action, this.#config, signal);
    if (!preview.ok) return preview;
    if (signal?.aborted) return resultFailure("cancelled", "skill action request was cancelled");
    const paramsDigest = skillActionParamsDigest(action);
    let record;
    try {
      record = await this.#operationLog.append({
        requestId: `skills:${action.kind}:${Date.now()}`,
        kind: action.kind,
        paramsDigest,
        artifactRefs: [],
      });
    } catch {
      return resultFailure("record-failed", "could not record skill action request");
    }
    skillActionsStateFor(this).pending.set(record.id, { kind: action.kind, input: action, preview: preview.value, paramsDigest });
    return { ok: true, value: { operationId: record.id, kind: action.kind, paramsDigest, preview: preview.value } };
  }

  /** One-shot UI execution (TASK-039): same kernel, no operation log. */
  async runDirect(input: SkillActionInput, signal?: AbortSignal): Promise<SkillActionExecution> {
    if (skillActionsStateFor(this).disposed) return executionFailure("service-disposed", "IMO skill action service is disposed", "");
    if (signal?.aborted) return executionFailure("cancelled", "skill action was cancelled", "");
    const normalized = normalizeSkillAction(input, this.#config.allowedGitHosts);
    if (!normalized.ok) return normalized as unknown as SkillActionExecution;
    if (skillActionsStateFor(this).running !== null || this.#catalogInFlight.size > 0) return executionFailure("busy", "another skill action is already running", "");
    const operationId = `direct:${normalized.value.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    skillActionsStateFor(this).running = { operationId, kind: normalized.value.kind };
    try {
      const catalogValidated = await this.validateCatalogInstall(normalized.value, signal);
      if (!catalogValidated.ok) return executionFailure(catalogValidated.error.code, catalogValidated.error.message);
      const action = catalogValidated.value;
      const preview = await previewSkillAction(this.ctx, this.#skills, this.#activation, action, this.#config, signal);
      if (!preview.ok) return preview as unknown as SkillActionExecution;
      const pending: PendingSkillAction = { kind: action.kind, input: action, preview: preview.value, paramsDigest: skillActionParamsDigest(action) };
      return await this.executeDirectKernel(operationId, pending, signal);
    } finally {
      skillActionsStateFor(this).running = null;
    }
  }

  /** Direct kernel: executePending minus every operationLog write. */
  private async executeDirectKernel(operationId: string, pending: PendingSkillAction, signal?: AbortSignal): Promise<SkillActionExecution> {
    const startedAt = new Date().toISOString();
    try {
      const before = pending.preview.before;
      if (before === undefined) {
        return this.directReceipt(operationId, pending, startedAt, { status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST, beforeCount: 0, afterCount: 0, added: [], removed: [], updated: [], catalogInvalidated: false, startedAt });
      }
      const expectedRevision = pending.preview.activation?.revision;
      if (this.#controller === undefined) {
        return this.directReceipt(operationId, pending, startedAt, { status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST, beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [], activationAfterRevision: undefined, catalogInvalidated: false, startedAt });
      }
      let initialized: ImoSkillActivationSnapshot;
      try {
        initialized = await this.#controller.ensureInitialized(before.names);
      } catch {
        return this.directReceipt(operationId, pending, startedAt, { status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST, beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [], activationBeforeRevision: expectedRevision, activationAfterRevision: undefined, catalogInvalidated: false, startedAt });
      }
      if (expectedRevision !== undefined && initialized.revision !== expectedRevision) {
        return this.directReceipt(operationId, pending, startedAt, { status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST, beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [], activationBeforeRevision: expectedRevision, activationAfterRevision: initialized.revision, catalogInvalidated: false, startedAt });
      }
      try {
        if (pending.input.kind === SKILL_ACTIVATION_KIND) {
          return await this.directActivation(operationId, pending, before, initialized, expectedRevision, startedAt, signal);
        }
        return await this.directCli(operationId, pending, before, initialized, expectedRevision, startedAt, signal);
      } catch {
        const recovery = await recoverInventory({ ctx: this.ctx, skills: this.#skills, controller: this.#controller, face: this.#activation, kind: pending.input.kind, beforeNames: before.names, expectedRevision });
        const after = recovery.after;
        const diff = after === undefined ? EMPTY_DIFF : diffInventory(before, after);
        const changed = diff.added.length + diff.removed.length + diff.updated.length > 0;
        return this.directReceipt(operationId, pending, startedAt, {
          status: changed ? "partial-failure" : "failed",
          exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
          beforeCount: before.names.length, afterCount: after?.names.length ?? before.names.length,
          added: diff.added, removed: diff.removed, updated: diff.updated,
          activationBeforeRevision: expectedRevision ?? initialized.revision,
          activationAfterRevision: recovery.activationRevision ?? expectedRevision ?? initialized.revision,
          catalogInvalidated: recovery.catalogInvalidated, startedAt,
        });
      }
    } catch {
      return executionFailure("execution-outcome-unknown", "skill action outcome could not be determined", operationId);
    }
  }

  private async directActivation(operationId: string, pending: PendingSkillAction, before: SkillInventorySnapshot, initialized: ImoSkillActivationSnapshot, expectedRevision: number | undefined, startedAt: string, signal?: AbortSignal): Promise<SkillActionExecution> {
    void signal;
    const input = pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_ACTIVATION_KIND }>;
    let afterActivation;
    try {
      afterActivation = await this.#controller!.setEnabled(input.name, input.enabled, before.names, expectedRevision);
    } catch {
      return this.directReceipt(operationId, pending, startedAt, { status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST, beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [], activationBeforeRevision: expectedRevision ?? initialized.revision, activationAfterRevision: initialized.revision, catalogInvalidated: false, startedAt });
    }
    let catalogInvalidated = false;
    try { invalidateInsuremoSkillCatalog(this.ctx); catalogInvalidated = true; } catch { catalogInvalidated = false; }
    return this.directReceipt(operationId, pending, startedAt, {
      status: "completed", exitCode: 0, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
      beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
      activationBeforeRevision: expectedRevision ?? initialized.revision, activationAfterRevision: afterActivation.revision,
      catalogInvalidated, startedAt,
    });
  }

  private async directCli(operationId: string, pending: PendingSkillAction, before: SkillInventorySnapshot, initialized: ImoSkillActivationSnapshot, expectedRevision: number | undefined, startedAt: string, signal?: AbortSignal): Promise<SkillActionExecution> {
    const command = actionCommand(pending.input, this.#config.command);
    const args = executionArgs(pending.input);
    const run = await runCaptureDetailed(this.ctx.subprocess, { command, args, timeoutMs: this.#config.timeoutMs, signal });
    this.captureRunDiagnosis(pending, command, args, run);
    if (!run.ok && run.error.code === "not-found" && command === SKILLS_TOOL_COMMAND) {
      // npx never resolved: nothing ran, so surface the structured tool error
      // instead of a misleading failed receipt. The diagnosis was already
      // recorded above (structured reason, empty streams).
      return executionFailure("tool-unavailable", "npx is unavailable; install Node.js/npm to sync Skills", operationId);
    }
    const recovery: RecoveryReport = await recoverInventory({ ctx: this.ctx, skills: this.#skills, controller: this.#controller, face: this.#activation, kind: pending.input.kind, beforeNames: before.names, expectedRevision });
    const after = recovery.after;
    const diff = after === undefined ? EMPTY_DIFF : diffInventory(before, after);
    const changed = diff.added.length + diff.removed.length + diff.updated.length > 0;
    const status = run.ok ? "completed" : (changed ? "partial-failure" : "failed");
    this.#catalogCache.clear();
    if (status === "completed") failureDiagnosis.clear("skill");
    const stdoutDigest = run.ok ? run.value.stdoutDigest : (run.error.stdoutDigest ?? EMPTY_DIGEST);
    const stderrDigest = run.ok ? run.value.stderrDigest : (run.error.stderrDigest ?? EMPTY_DIGEST);
    const exitCode = run.ok ? run.value.exitCode : (run.error.exitCode ?? null);
    const hint = !run.ok
      ? (run.error.httpStatus === 401 ? "login-required" : run.error.httpStatus === 403 ? "permission-denied" : undefined)
      : undefined;
    return this.directReceipt(operationId, pending, startedAt, {
      status, exitCode, stdoutDigest, stderrDigest,
      beforeCount: before.names.length,
      afterCount: after?.names.length ?? before.names.length,
      added: diff.added, removed: diff.removed, updated: diff.updated,
      activationBeforeRevision: expectedRevision ?? initialized.revision,
      activationAfterRevision: recovery.activationRevision ?? expectedRevision ?? initialized.revision,
      catalogInvalidated: recovery.catalogInvalidated, startedAt,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  /**
   * Record one failed skills-tool run's raw streams (memory-only diagnosis).
   * Install/update only; remove/activation failures carry no command output
   * worth diagnosing here, and the receipt stays digest-only regardless.
   */
  private captureRunDiagnosis(pending: PendingSkillAction, command: string, args: readonly string[], run: Awaited<ReturnType<typeof runCaptureDetailed>>): void {
    if (run.ok) return;
    if (pending.input.kind !== SKILL_INSTALL_KIND && pending.input.kind !== SKILL_UPDATE_KIND) return;
    const unavailable = run.error.code === "not-found" && command === SKILLS_TOOL_COMMAND;
    failureDiagnosis.record({
      kind: "skill",
      operation: skillDiagnosisOperation(pending.input),
      commands: [`${command} ${args.join(" ")}`],
      exitCode: run.error.exitCode ?? null,
      streams: {
        stdout: run.detail?.stdout ?? "",
        stderr: run.detail?.stderr ?? "",
        stdoutLossy: run.detail?.stdoutLossy ?? false,
        stderrLossy: run.detail?.stderrLossy ?? false,
      },
      // A not-found run executed nothing (empty streams); the structured
      // reason is what makes the entry diagnosable in the UI.
      error: unavailable
        ? { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" }
        : { code: run.error.code, message: run.error.message },
    });
  }

  /** Direct receipt: built like the approval receipt, never journaled. */
  private directReceipt(operationId: string, pending: PendingSkillAction, startedAt: string, input: Omit<SkillReceiptInput, "operationId" | "kind">): SkillActionExecution {
    const provenance: Partial<SkillReceiptInput> = pending.input.kind === SKILL_INSTALL_KIND
      ? installSourceProvenance((pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_INSTALL_KIND }>).source)
      : pending.input.kind === SKILL_REMOVE_KIND
        ? { actionTargetDigest: digest(`remove:${(pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_REMOVE_KIND }>).names.join(",")}`) }
        : pending.input.kind === SKILL_UPDATE_KIND
          ? { actionTargetDigest: digest("update:all") }
          : { actionTargetDigest: digest(`activation:${(pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_ACTIVATION_KIND }>).name}:${(pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_ACTIVATION_KIND }>).enabled}`) };
    const { receipt } = buildSkillReceipt({ operationId, kind: pending.kind, ...input, ...provenance });
    return input.hint === undefined ? { ok: true, receipt } : { ok: true, receipt, hint: input.hint };
  }

  async execute(operationId: string, signal?: AbortSignal): Promise<SkillActionExecution> {
    const record = this.#operationLog.list().find(candidate => candidate.id === operationId);
    if (record === undefined) return executionFailure("missing-operation", "skill action operation does not exist", operationId);
    if (record.decision !== "approved") return executionFailure("not-approved", "only approved skill actions may run", operationId);
    if (record.resultDigest !== undefined) return executionFailure("already-executed", "skill action operation already has a result", operationId);
    // In-memory journal: an executed attempt is never re-run.
    const journal = skillActionsStateFor(this).journal.get(operationId);
    if (journal?.state === "executed") {
      if (journal.outcomeUnknown) return executionFailure("execution-outcome-unknown", "skill action outcome could not be determined; it will never be re-run", operationId);
      if (journal.evidenceRecorded) return executionFailure("already-executed", "skill action operation already has a result", operationId);
      // Evidence was not yet durably recorded: retry recordResult only.
      return this.retryEvidence(operationId, journal);
    }
    if (skillActionsStateFor(this).disposed) return executionFailure("service-disposed", "IMO skill action service is disposed", operationId);
    if (journal?.state === "executing") return executionFailure("busy", "another skill action attempt is already running", operationId);
    const pending = skillActionsStateFor(this).pending.get(operationId);
    if (pending === undefined) return executionFailure("missing-pending-input", "skill action parameters are unavailable; re-request the action", operationId);
    if (record.kind !== pending.kind || record.paramsDigest !== pending.paramsDigest || record.paramsDigest !== skillActionParamsDigest(pending.input)) {
      return executionFailure("operation-params-mismatch", "skill action operation parameters do not match", operationId);
    }
    // Approval may outlive the catalog TTL. Re-check the trusted membership
    // immediately before mutation so an expired/failed cache never acts as a
    // stale whitelist. The check may perform one bounded controlled refresh.
    const catalogValidated = await this.validateCatalogInstall(pending.input, signal);
    if (!catalogValidated.ok) return executionFailure(catalogValidated.error.code, catalogValidated.error.message, operationId);
    if (skillActionsStateFor(this).running !== null) return executionFailure("busy", "another skill action is already running", operationId);
    skillActionsStateFor(this).running = { operationId, kind: pending.kind };
    try {
      return await this.executePending(operationId, pending, signal);
    } finally {
      skillActionsStateFor(this).running = null;
    }
  }

  status(): SkillActionStatus {
    const current = skillActionsStateFor(this).running;
    return current === null ? { running: false } : { running: true, current: { operationId: current.operationId, kind: current.kind } };
  }

  private async executePending(operationId: string, pending: PendingSkillAction, signal?: AbortSignal): Promise<SkillActionExecution> {
    if (!skillActionsStateFor(this).journal.begin(operationId)) return executionFailure("already-executed", "skill action operation already has a result", operationId);
    const before = pending.preview.before;
    if (before === undefined) {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: 0, afterCount: 0, added: [], removed: [], updated: [], catalogInvalidated: false,
        startedAt: new Date().toISOString(),
      });
    }
    const startedAt = new Date().toISOString();
    const expectedRevision = pending.preview.activation?.revision;
    if (this.#controller === undefined) {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
        catalogInvalidated: false, startedAt,
      });
    }
    let initialized: ImoSkillActivationSnapshot;
    try {
      initialized = await this.#controller.ensureInitialized(before.names);
    } catch (error) {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
        activationAfterRevision: undefined, catalogInvalidated: false, startedAt,
      });
    }
    if (expectedRevision !== undefined && initialized.revision !== expectedRevision) {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
        activationBeforeRevision: expectedRevision, activationAfterRevision: initialized.revision, catalogInvalidated: false, startedAt,
      });
    }
    try {
      if (pending.input.kind === SKILL_ACTIVATION_KIND) {
        return await this.runActivation(operationId, pending, before, initialized, expectedRevision, startedAt, signal);
      }
      return await this.runCli(operationId, pending, before, initialized, expectedRevision, startedAt, signal);
    } catch {
      // Undeterminable outcome: never re-run; best-effort recovery only.
      const recovery = await recoverInventory({
        ctx: this.ctx, skills: this.#skills, controller: this.#controller, face: this.#activation,
        kind: pending.input.kind, beforeNames: before.names, expectedRevision,
      });
      skillActionsStateFor(this).journal.markOutcomeUnknown(operationId);
      return executionFailure("execution-outcome-unknown", "skill action outcome could not be determined; it will never be re-run", operationId);
    }
  }

  private async runActivation(
    operationId: string,
    pending: PendingSkillAction,
    before: SkillInventorySnapshot,
    initialized: ImoSkillActivationSnapshot,
    expectedRevision: number | undefined,
    startedAt: string,
    signal: AbortSignal | undefined,
  ): Promise<SkillActionExecution> {
    if (signal?.aborted) {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
        activationBeforeRevision: expectedRevision ?? initialized.revision, activationAfterRevision: initialized.revision,
        catalogInvalidated: false, startedAt,
      });
    }
    let afterActivation;
    const input = pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_ACTIVATION_KIND }>;
    try {
      afterActivation = await this.#controller!.setEnabled(input.name, input.enabled, before.names, expectedRevision);
    } catch {
      return this.recordOutcome(operationId, pending, {
        status: "failed", exitCode: null, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
        beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
        activationBeforeRevision: expectedRevision ?? initialized.revision, activationAfterRevision: initialized.revision,
        catalogInvalidated: false, startedAt,
      });
    }
    let catalogInvalidated = false;
    try { invalidateInsuremoSkillCatalog(this.ctx); catalogInvalidated = true; } catch { catalogInvalidated = false; }
    return this.recordOutcome(operationId, pending, {
      status: "completed", exitCode: 0, stdoutDigest: EMPTY_DIGEST, stderrDigest: EMPTY_DIGEST,
      beforeCount: before.names.length, afterCount: before.names.length, added: [], removed: [], updated: [],
      activationBeforeRevision: expectedRevision ?? initialized.revision, activationAfterRevision: afterActivation.revision,
      catalogInvalidated, startedAt,
    });
  }

  private async runCli(
    operationId: string,
    pending: PendingSkillAction,
    before: SkillInventorySnapshot,
    initialized: ImoSkillActivationSnapshot,
    expectedRevision: number | undefined,
    startedAt: string,
    signal: AbortSignal | undefined,
  ): Promise<SkillActionExecution> {
    const command = actionCommand(pending.input, this.#config.command);
    const args = executionArgs(pending.input);
    const run = await runCaptureDetailed(this.ctx.subprocess, { command, args, timeoutMs: this.#config.timeoutMs, signal });
    this.captureRunDiagnosis(pending, command, args, run);
    if (!run.ok && run.error.code === "not-found" && command === SKILLS_TOOL_COMMAND) {
      return executionFailure("tool-unavailable", "npx is unavailable; install Node.js/npm to sync Skills", operationId);
    }
    // Once the external attempt has started, recovery is best-effort always.
    const recovery: RecoveryReport = await recoverInventory({
      ctx: this.ctx, skills: this.#skills, controller: this.#controller, face: this.#activation,
      kind: pending.input.kind, beforeNames: before.names, expectedRevision,
    });
    const after = recovery.after;
    const diff = after === undefined ? EMPTY_DIFF : diffInventory(before, after);
    const changed = diff.added.length + diff.removed.length + diff.updated.length > 0;
    const status = run.ok ? "completed" : (changed ? "partial-failure" : "failed");
    this.#catalogCache.clear();
    if (status === "completed") failureDiagnosis.clear("skill");
    const stdoutDigest = run.ok ? run.value.stdoutDigest : (run.error.stdoutDigest ?? EMPTY_DIGEST);
    const stderrDigest = run.ok ? run.value.stderrDigest : (run.error.stderrDigest ?? EMPTY_DIGEST);
    const exitCode = run.ok ? run.value.exitCode : (run.error.exitCode ?? null);
    const hint = !run.ok
      ? (run.error.httpStatus === 401 ? "login-required" : run.error.httpStatus === 403 ? "permission-denied" : undefined)
      : undefined;
    return this.recordOutcome(operationId, pending, {
      status, exitCode, stdoutDigest, stderrDigest,
      beforeCount: before.names.length,
      afterCount: after?.names.length ?? before.names.length,
      added: diff.added, removed: diff.removed, updated: diff.updated,
      activationBeforeRevision: expectedRevision ?? initialized.revision,
      activationAfterRevision: recovery.activationRevision ?? expectedRevision ?? initialized.revision,
      catalogInvalidated: recovery.catalogInvalidated,
      ...(hint === undefined ? {} : { hint }),
      startedAt,
    });
  }

  /** Build the immutable receipt, journal it, emit once, then record evidence. */
  private async recordOutcome(
    operationId: string,
    pending: PendingSkillAction,
    input: Omit<SkillReceiptInput, "operationId" | "kind">,
  ): Promise<SkillActionExecution> {
    const full: SkillReceiptInput = { operationId, kind: pending.kind, ...input, ...this.provenanceFor(pending) };
    const { receipt, resultDigest } = buildSkillReceipt(full);
    skillActionsStateFor(this).journal.commit(operationId, receipt, resultDigest);
    if (!skillActionsStateFor(this).journal.isEventEmitted(operationId)) {
      skillActionsStateFor(this).journal.markEventEmitted(operationId);
      this.emitActionEvent(receipt, resultDigest);
    }
    try {
      await this.#operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") {
        skillActionsStateFor(this).journal.markEvidenceRecorded(operationId);
        return executionFailure("already-executed", "skill action operation already has a result", operationId);
      }
      return { ok: true, receipt, ...(input.hint === undefined ? {} : { hint: input.hint }), evidencePending: true };
    }
    skillActionsStateFor(this).journal.markEvidenceRecorded(operationId);
    skillActionsStateFor(this).pending.delete(operationId);
    return { ok: true, receipt, ...(input.hint === undefined ? {} : { hint: input.hint }) };
  }

  /** Evidence-only retry: zero spawn, zero controller, zero invalidate. */
  private async retryEvidence(operationId: string, journal: ExecutionJournalEntry): Promise<SkillActionExecution> {
    const receipt = journal.receipt!;
    const resultDigest = journal.resultDigest!;
    try {
      await this.#operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") {
        skillActionsStateFor(this).journal.markEvidenceRecorded(operationId);
        if (!journal.eventEmitted) {
          skillActionsStateFor(this).journal.markEventEmitted(operationId);
          this.emitActionEvent(receipt, resultDigest);
        }
        return executionFailure("already-executed", "skill action operation already has a result", operationId);
      }
      return { ok: true, receipt, evidencePending: true };
    }
    skillActionsStateFor(this).journal.markEvidenceRecorded(operationId);
    if (!journal.eventEmitted) {
      skillActionsStateFor(this).journal.markEventEmitted(operationId);
      this.emitActionEvent(receipt, resultDigest);
    }
    skillActionsStateFor(this).pending.delete(operationId);
    return { ok: true, receipt };
  }

  private provenanceFor(pending: PendingSkillAction): Partial<SkillReceiptInput> {
    if (pending.input.kind === SKILL_INSTALL_KIND) {
      const provenance = installSourceProvenance(pending.input.source);
      return {
        sourceKind: provenance.sourceKind,
        ...(provenance.sourceHost === undefined ? {} : { sourceHost: provenance.sourceHost }),
        sourceDigest: provenance.sourceDigest,
      };
    }
    if (pending.input.kind === SKILL_REMOVE_KIND) return { actionTargetDigest: digest(`remove:${pending.input.names.join(",")}`) };
    if (pending.input.kind === SKILL_UPDATE_KIND) return { actionTargetDigest: digest("update:all") };
    const input = pending.input as Extract<NormalizedSkillAction, { kind: typeof SKILL_ACTIVATION_KIND }>;
    return { actionTargetDigest: digest(`activation:${input.name}:${input.enabled}`) };
  }

  private emitActionEvent(receipt: SkillActionReceipt, resultDigest: string): void {
    const event: SkillActionEvent = {
      operationId: receipt.operationId,
      kind: receipt.kind,
      status: receipt.status,
      resultDigest,
      ...(receipt.sourceKind === undefined ? {} : { sourceKind: receipt.sourceKind }),
      ...(receipt.sourceHost === undefined ? {} : { sourceHost: receipt.sourceHost }),
      ...(receipt.sourceDigest === undefined ? {} : { sourceDigest: receipt.sourceDigest }),
      ...(receipt.actionTargetDigest === undefined ? {} : { actionTargetDigest: receipt.actionTargetDigest }),
    };
    this.ctx.emit(receipt.status === "completed" ? SKILL_ACTION_COMPLETED_EVENT : SKILL_ACTION_FAILED_EVENT, event);
  }
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function resultFailure<T = never>(code: SkillActionError["code"], message: string): SkillActionResult<T> {
  return { ok: false, error: { code, message } };
}

function executionFailure(code: SkillActionError["code"], message: string, operationId?: string): SkillActionExecution {
  return { ok: false, error: { code, message, ...(operationId === undefined ? {} : { operationId }) } };
}
