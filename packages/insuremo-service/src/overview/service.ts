import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import type { ImoCli } from "../cli.ts";
import type { ImoAuth } from "../auth/types.ts";
import { resolveWorkspace, workspaceScopeKey } from "../auth/workspace.ts";
import { ACTIVE_PROFILE_CHANGED_EVENT, type ImoActiveProfile } from "../active-profile.ts";
import type { ImoSkills } from "../skills.ts";
import type { ImoSkillActivation } from "../skill-activation.ts";
import type { OperationLogLike } from "../operation-log-face.ts";
import { buildOverview, type OverviewDependencies } from "./snapshot.ts";
import { IMO_INSTALL_COMPLETED_EVENT, IMO_INSTALL_FAILED_EVENT } from "../imo-install.ts";
import { buildWorkspaceStatuses, DEFAULT_EMBEDDING_ENDPOINT } from "./workspaces-status.ts";
import type { OverviewOperationsSection, ImoOverviewView } from "./types.ts";

/** Cold-start degraded sections for the fast channel (never fake "None"). */
const FAST_UNCACHED_IMO = Object.freeze({ status: "warning", code: "fast-uncached", available: false, updateAvailable: false });
const FAST_UNCACHED_SKILLS = Object.freeze({
  status: "warning",
  code: "fast-uncached",
  installed: 0,
  valid: 0,
  enabled: 0,
  disabled: 0,
  names: [],
  entries: [],
  entriesTruncated: false,
  formatInvalidCount: 0,
  pathIssueCount: 0,
  diagnosticCount: 0,
  diagnostics: [],
  diagnosticsTruncated: false,
});

type ImoOverviewAuthSection = ImoOverviewView["auth"];

type OverviewCacheEntry<T> = { readonly at: number; readonly view: T };

const MIN_TTL_MS = 0;
const MAX_TTL_MS = 5_000;

/** Public read-only overview face: `ctx.imoOverview.snapshot(signal?, workspaceId?)`. */
export interface ImoOverview {
  snapshot(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoOverviewView>;
  /** Fast channel (TASK-041), partitioned by the selected workspace cwd. */
  snapshotFast(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoOverviewView>;
}

/** Read-only aggregate overview service with coalescing and an optional short TTL. */
export class ImoOverviewService extends Service implements ImoOverview {
  static inject = ["imoCli", "imoAuth", "imoActiveProfile", "imoSkills", "imoSkillActivation", "operationLog"];
  static Config = Config;

  #dependencies: OverviewDependencies;
  #ttlMs: number;
  #cached = new Map<string, OverviewCacheEntry<ImoOverviewView>>();
  #inflight = new Map<string, Promise<ImoOverviewView>>();
  #lastImo = new Map<string, ImoOverviewView["imo"]>();
  #lastSkills = new Map<string, ImoOverviewView["skills"]>();
  #lastAuth = new Map<string, ImoOverviewView["auth"]>();
  #disposed = false;
  #cacheGeneration = 0;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoOverview");
    const resolved = resolveConfig(config);
    this.#ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, resolved.overviewTtlMs));
    this.#dependencies = {
      imoCli: ctx.get<ImoCli>("imoCli")!,
      imoAuth: ctx.get<ImoAuth>("imoAuth")!,
      imoActiveProfile: ctx.get<ImoActiveProfile>("imoActiveProfile") ?? {
        get: async () => ({ ok: true, value: { activeProfileName: null, revision: 0, status: "none" as const } }),
        select: async () => ({ ok: false, error: { code: "unavailable" as const, message: "active profile unavailable" } }),
      },
      imoSkills: ctx.get<ImoSkills>("imoSkills")!,
      imoSkillActivation: ctx.get<ImoSkillActivation>("imoSkillActivation")!,
      operationLog: ctx.get<OperationLogLike>("operationLog")!,
      imoUpgrade: ctx.get<{ upgradeStatus(): { running: boolean } }>("imoUpgrade"),
      imoInstall: ctx.get<{ installStatus(): { running: boolean } }>("imoInstall"),
    };
    this.snapshot = this.snapshot.bind(this);
    this.snapshotFast = this.snapshotFast.bind(this);
    this.ctx.effect(() => {
      const off = this.ctx.on(ACTIVE_PROFILE_CHANGED_EVENT, () => {
        this.#cacheGeneration += 1;
        this.#cached.clear();
        this.#lastAuth.clear();
        // Detach older full reads so a subsequent caller starts from the new
        // active selection. Old promises may finish, but cannot publish cache.
        this.#inflight.clear();
      });
      const offInstallCompleted = this.ctx.on(IMO_INSTALL_COMPLETED_EVENT, () => {
        this.#cacheGeneration += 1;
        this.#cached.clear();
        this.#lastImo.clear();
        this.#inflight.clear();
        void this.snapshot(undefined).catch(() => { /* best-effort rebuild */ });
      });
      const offInstallFailed = this.ctx.on(IMO_INSTALL_FAILED_EVENT, () => {
        this.#cacheGeneration += 1;
        this.#cached.clear();
        this.#inflight.clear();
      });
      return () => {
        off?.();
        offInstallCompleted?.();
        offInstallFailed?.();
        this.#disposed = true;
        this.#cached.clear();
        this.#inflight.clear();
        this.#lastImo.clear();
        this.#lastSkills.clear();
        this.#lastAuth.clear();
      };
    }, "imoOverview.state");
  }

  async snapshot(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    const scopeKey = this.cacheScope(workspaceId);
    if (signal === undefined && this.#ttlMs > 0 && scopeKey !== undefined) {
      const cached = this.#cached.get(scopeKey);
      if (cached !== undefined && Date.now() - cached.at <= this.#ttlMs) return cached.view;
    }
    const existing = scopeKey === undefined ? undefined : this.#inflight.get(scopeKey);
    if (existing !== undefined) return existing;
    const generation = this.#cacheGeneration;
    let inflight: Promise<ImoOverviewView>;
    inflight = buildOverview(this.#dependencies, signal, workspaceId).then(async (view) => {
      const statuses = await buildWorkspaceStatuses(this.ctx as never).catch(() => []);
      const enriched = Object.freeze({
        ...view,
        ici: Object.freeze({
          status: "ok" as const,
          embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT,
          graphWorkspaces: statuses.filter(entry => entry.graphReady).length,
          explainWorkspaces: statuses.filter(entry => entry.explainReady).length,
        }),
      });
      if (generation === this.#cacheGeneration && scopeKey !== undefined) {
        this.#lastImo.set(scopeKey, view.imo);
        this.#lastSkills.set(scopeKey, view.skills);
        this.#lastAuth.set(scopeKey, view.auth);
        this.#cached.set(scopeKey, { at: Date.now(), view: enriched });
      }
      if (scopeKey !== undefined && this.#inflight.get(scopeKey) === inflight) this.#inflight.delete(scopeKey);
      return enriched;
    }, (error) => {
      if (scopeKey !== undefined && this.#inflight.get(scopeKey) === inflight) this.#inflight.delete(scopeKey);
      throw error;
    });
    if (scopeKey !== undefined) this.#inflight.set(scopeKey, inflight);
    return inflight;
  }

  async snapshotFast(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    const scopeKey = this.cacheScope(workspaceId);
    const auth = await this.#fastAuth(signal, workspaceId, scopeKey);
    const imo = scopeKey === undefined ? FAST_UNCACHED_IMO : this.#lastImo.get(scopeKey) ?? FAST_UNCACHED_IMO;
    const skills = scopeKey === undefined ? FAST_UNCACHED_SKILLS : this.#lastSkills.get(scopeKey) ?? FAST_UNCACHED_SKILLS;
    const operations = this.#fastOperations();
    const statuses = await buildWorkspaceStatuses(this.ctx as never).catch(() => [] as readonly { graphReady: boolean; explainReady: boolean }[]);
    return Object.freeze({
      schemaVersion: "0" as const,
      generatedAt: new Date().toISOString(),
      imo,
      auth,
      skills,
      operations,
      diagnostics: Object.freeze({ status: "ok" as const, diagnostics: [] }),
      ici: Object.freeze({
        status: "ok" as const,
        embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT,
        graphWorkspaces: statuses.filter(entry => entry.graphReady).length,
        explainWorkspaces: statuses.filter(entry => entry.explainReady).length,
      }),
    });
  }

  #fastAuth(signal?: AbortSignal, workspaceId?: string | null, scopeKey?: string): Promise<ImoOverviewAuthSection> {
    return this.fastAuthImpl(signal, workspaceId, scopeKey);
  }

  private async fastAuthImpl(signal?: AbortSignal, workspaceId?: string | null, scopeKey?: string): Promise<ImoOverviewAuthSection> {
    // Fast is deliberately projection-only: it never starts a full snapshot.
    const listed = await this.#dependencies.imoAuth.listProfilesCached(signal, workspaceId).catch(() => undefined);
    if (listed !== undefined && listed.ok) {
      const active = this.#dependencies.imoActiveProfile === undefined
        ? undefined
        : await this.#dependencies.imoActiveProfile.get(signal, workspaceId).catch(() => undefined);
      const activeView = active?.ok === true ? active.value : undefined;
      const activeName = activeView?.activeProfileName ?? null;
      const profiles = listed.value.profiles.slice(0, 100).map(profile => Object.freeze({
        name: profile.profileName,
        ...(profile.env === undefined ? {} : { env: profile.env }),
        ...(profile.tenantCode === undefined ? {} : { tenantCode: profile.tenantCode }),
        ...(profile.accountName === undefined ? {} : { account: profile.accountName }),
        ...(profile.scope === "workspace" || profile.scope === "global" ? { sourceScope: profile.scope } : {}),
        isDefault: profile.isDefault === true,
        isActive: activeName === profile.profileName,
      }));
      const diagnosticDefault = profiles.find(profile => profile.isDefault)?.name;
      const result = Object.freeze({
        status: activeView?.status === "active" || activeView?.status === "none" ? "ok" as const : "warning" as const,
        profiles,
        count: profiles.length,
        ...(diagnosticDefault === undefined ? {} : { defaultProfile: diagnosticDefault, defaultProfileName: diagnosticDefault }),
        activeProfileName: activeName,
        ...(activeView === undefined ? {} : { activeProfileRevision: activeView.revision, activeProfileStatus: activeView.status }),
      });
      if (scopeKey !== undefined) this.#lastAuth.set(scopeKey, result);
      return result;
    }
    // An explicit workspace failure must never borrow the global identity.
    if (workspaceId !== undefined && workspaceId !== null) {
      const code = listed !== undefined && !listed.ok
        && (listed.error.code === "workspace-not-found" || listed.error.code === "workspace-unavailable" || listed.error.code === "invalid-workspace-id")
        ? listed.error.code
        : "unavailable";
      return Object.freeze({ status: "warning" as const, code, profiles: [], count: 0 });
    }
    return scopeKey === undefined
      ? Object.freeze({ status: "warning" as const, code: "fast-uncached", profiles: [], count: 0 })
      : this.#lastAuth.get(scopeKey) ?? Object.freeze({ status: "warning" as const, code: "fast-uncached", profiles: [], count: 0 });
  }

  #fastOperations(): OverviewOperationsSection {
    try {
      const records = this.#dependencies.operationLog.list();
      let pending = 0;
      for (const record of records) {
        if (record.decision === "pending") pending += 1;
      }
      return Object.freeze({ status: "ok", pending, approved: 0, rejected: 0, recorded: 0, recent: [] });
    } catch {
      return Object.freeze({ status: "error", code: "unavailable", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] });
    }
  }

  private cacheScope(workspaceId?: string | null): string | undefined {
    if (workspaceId === undefined || workspaceId === null) return "global";
    const resolved = resolveWorkspace(this.ctx, workspaceId);
    return resolved.ok ? workspaceScopeKey(resolved.workspaceId, resolved.cwd) : undefined;
  }

  private cancelledView(): ImoOverviewView {
    return Object.freeze({
      schemaVersion: "0" as const,
      generatedAt: new Date().toISOString(),
      imo: Object.freeze({ status: "error" as const, code: "cancelled", available: false, updateAvailable: false }),
      auth: Object.freeze({ status: "error" as const, code: "cancelled", profiles: [], count: 0 }),
      skills: Object.freeze({
        status: "error" as const,
        code: "cancelled",
        installed: 0,
        valid: 0,
        enabled: 0,
        disabled: 0,
        names: [],
        entries: [],
        entriesTruncated: false,
        formatInvalidCount: 0,
        pathIssueCount: 0,
        diagnosticCount: 0,
        diagnostics: [],
        diagnosticsTruncated: false,
      }),
      operations: Object.freeze({ status: "error" as const, code: "cancelled", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] }),
      diagnostics: Object.freeze({ status: "error" as const, diagnostics: [Object.freeze({ id: "overview-cancelled", severity: "error" as const, messageKey: "overview.diagnostic.cancelled" })] }),
      ici: Object.freeze({ status: "warning" as const, embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT, graphWorkspaces: 0, explainWorkspaces: 0 }),
    });
  }
}

export { OVERVIEW_PATH } from "./paths.ts";
