import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import type { ImoCli } from "../cli.ts";
import type { ImoAuth } from "../auth/types.ts";
import { ACTIVE_PROFILE_CHANGED_EVENT, type ImoActiveProfile } from "../active-profile.ts";
import type { ImoSkills } from "../skills.ts";
import type { ImoSkillActivation } from "../skill-activation.ts";
import type { OperationLogLike } from "../operation-log-face.ts";
import { buildOverview, type OverviewDependencies } from "./snapshot.ts";
import { buildWorkspaceStatuses, DEFAULT_EMBEDDING_ENDPOINT } from "./workspaces-status.ts";
import type { OverviewOperationsSection, ImoOverviewView } from "./types.ts";

/** Cold-start degraded sections for the fast channel (never fake "None"). */
const FAST_UNCACHED_IMO = Object.freeze({ status: "warning", code: "fast-uncached", available: false, updateAvailable: false });
const FAST_UNCACHED_SKILLS = Object.freeze({ status: "warning", code: "fast-uncached", installed: 0, valid: 0, enabled: 0, disabled: 0, names: [], entries: [], entriesTruncated: false });

type ImoOverviewAuthSection = ImoOverviewView["auth"];

const MIN_TTL_MS = 0;
const MAX_TTL_MS = 5_000;

/** Public read-only overview face: `ctx.imoOverview.snapshot(signal?)`. */
export interface ImoOverview {
  snapshot(signal?: AbortSignal): Promise<ImoOverviewView>;
  /**
   * Fast channel (TASK-041): millisecond auth from the profile store,
   * last-known imo/skills projections, memory-only operations/ici. It does
   * not invoke full snapshot or scan skills; auth may load its sanitized
   * cache provider on a cold start. Cold sections degrade with
   * `code:"fast-uncached"` (UI renders a skeleton, never a fake "None").
   */
  snapshotFast(signal?: AbortSignal): Promise<ImoOverviewView>;
}

/** Read-only aggregate overview service with coalescing and an optional short TTL. */
export class ImoOverviewService extends Service implements ImoOverview {
  static inject = ["imoCli", "imoAuth", "imoActiveProfile", "imoSkills", "imoSkillActivation", "operationLog"];
  static Config = Config;

  #dependencies: OverviewDependencies;
  #ttlMs: number;
  #cached: { readonly at: number; readonly view: ImoOverviewView } | undefined;
  #inflight: Promise<ImoOverviewView> | undefined;
  #lastImo: ImoOverviewView["imo"] | undefined;
  #lastSkills: ImoOverviewView["skills"] | undefined;
  #lastAuth: ImoOverviewView["auth"] | undefined;
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
    };
    this.snapshot = this.snapshot.bind(this);
    this.snapshotFast = this.snapshotFast.bind(this);
    this.ctx.effect(() => {
      const off = this.ctx.on(ACTIVE_PROFILE_CHANGED_EVENT, () => {
        this.#cacheGeneration += 1;
        this.#cached = undefined;
        this.#lastAuth = undefined;
        // Detach an older full read so the next caller starts from the new
        // active selection. The old promise may finish, but cannot publish.
        this.#inflight = undefined;
      });
      return () => {
        off?.();
        this.#disposed = true;
        this.#cached = undefined;
        this.#inflight = undefined;
      };
    }, "imoOverview.state");
  }

  async snapshot(signal?: AbortSignal): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    if (signal === undefined && this.#ttlMs > 0 && this.#cached !== undefined) {
      if (Date.now() - this.#cached.at <= this.#ttlMs) return this.#cached.view;
    }
    const existing = this.#inflight;
    if (existing !== undefined) return existing;
    const generation = this.#cacheGeneration;
    let inflight: Promise<ImoOverviewView>;
    inflight = buildOverview(this.#dependencies, signal).then(async (view) => {
      const statuses = await buildWorkspaceStatuses(this.ctx as never).catch(() => []);
      const enriched = Object.freeze({
        ...view,
        ici: Object.freeze({
          status: "ok",
          embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT,
          graphWorkspaces: statuses.filter(entry => entry.graphReady).length,
          explainWorkspaces: statuses.filter(entry => entry.explainReady).length,
        }),
      });
      if (generation === this.#cacheGeneration) {
        this.#lastImo = view.imo;
        this.#lastSkills = view.skills;
        this.#lastAuth = view.auth;
        this.#cached = { at: Date.now(), view: enriched };
      }
      if (this.#inflight === inflight) this.#inflight = undefined;
      return enriched;
    }, (error) => {
      if (this.#inflight === inflight) this.#inflight = undefined;
      throw error;
    });
    this.#inflight = inflight;
    return inflight;
  }

  async snapshotFast(signal?: AbortSignal): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    // Fast is deliberately projection-only: it never starts a full snapshot
    // or any CLI-backed work in the background.
    const auth = await this.#fastAuth(signal);
    const imo = this.#lastImo ?? FAST_UNCACHED_IMO;
    const skills = this.#lastSkills ?? FAST_UNCACHED_SKILLS;
    const operations = this.#fastOperations();
    const statuses = await buildWorkspaceStatuses(this.ctx as never).catch(() => [] as readonly { graphReady: boolean; explainReady: boolean }[]);
    return Object.freeze({
      schemaVersion: "0",
      generatedAt: new Date().toISOString(),
      imo,
      auth,
      skills,
      operations,
      diagnostics: Object.freeze({ status: "ok", diagnostics: [] }),
      ici: Object.freeze({
        status: "ok",
        embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT,
        graphWorkspaces: statuses.filter(entry => entry.graphReady).length,
        explainWorkspaces: statuses.filter(entry => entry.explainReady).length,
      }),
    });
  }

  async #fastAuth(signal?: AbortSignal): Promise<ImoOverviewAuthSection> {
    // The fast overview must not call profilesFast: that face also resolves
    // the CLI default pointer. Use only the sanitized cached inventory here;
    // default fields are best-effort diagnostics from isDefault markers.
    const listed = await this.#dependencies.imoAuth.listProfilesCached(signal).catch(() => undefined);
    if (listed !== undefined && listed.ok) {
      const active = this.#dependencies.imoActiveProfile === undefined
        ? undefined
        : await this.#dependencies.imoActiveProfile.get(signal).catch(() => undefined);
      const activeView = active?.ok === true ? active.value : undefined;
      const activeName = activeView?.activeProfileName ?? null;
      const profiles = listed.value.profiles.slice(0, 100).map(profile => Object.freeze({
        name: profile.profileName,
        ...(profile.env === undefined ? {} : { env: profile.env }),
        ...(profile.tenantCode === undefined ? {} : { tenantCode: profile.tenantCode }),
        ...(profile.accountName === undefined ? {} : { account: profile.accountName }),
        isDefault: profile.isDefault === true,
        isActive: activeName === profile.profileName,
      }));
      const diagnosticDefault = profiles.find(profile => profile.isDefault)?.name;
      return Object.freeze({
        status: activeView?.status === "active" || activeView?.status === "none" ? "ok" : "warning",
        profiles,
        count: profiles.length,
        ...(diagnosticDefault === undefined ? {} : { defaultProfile: diagnosticDefault, defaultProfileName: diagnosticDefault }),
        activeProfileName: activeName,
        ...(activeView === undefined ? {} : { activeProfileRevision: activeView.revision, activeProfileStatus: activeView.status }),
      });
    }
    return this.#lastAuth ?? Object.freeze({ status: "warning", code: "fast-uncached", profiles: [], count: 0 });
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

  private cancelledView(): ImoOverviewView {
    return Object.freeze({
      schemaVersion: "0",
      generatedAt: new Date().toISOString(),
      imo: Object.freeze({ status: "error", code: "cancelled", available: false, updateAvailable: false }),
      auth: Object.freeze({ status: "error", code: "cancelled", profiles: [], count: 0 }),
      skills: Object.freeze({ status: "error", code: "cancelled", installed: 0, valid: 0, enabled: 0, disabled: 0, names: [], entries: [], entriesTruncated: false }),
      operations: Object.freeze({ status: "error", code: "cancelled", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] }),
      diagnostics: Object.freeze({ status: "error", diagnostics: [Object.freeze({ id: "overview-cancelled", severity: "error", messageKey: "overview.diagnostic.cancelled" })] }),
      ici: Object.freeze({ status: "warning", embeddingUrl: DEFAULT_EMBEDDING_ENDPOINT, graphWorkspaces: 0, explainWorkspaces: 0 }),
    });
  }
}

export { OVERVIEW_PATH } from "./paths.ts";
