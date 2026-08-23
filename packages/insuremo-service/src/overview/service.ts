import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import type { ImoCli } from "../cli.ts";
import type { ImoAuth } from "../auth/types.ts";
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
   * last-known imo/skills projections, memory-only operations/ici. No CLI
   * subprocess, no skills file scan. Cold sections degrade with
   * `code:"fast-uncached"` (UI renders a skeleton, never a fake "None").
   */
  snapshotFast(signal?: AbortSignal): Promise<ImoOverviewView>;
}

/** Read-only aggregate overview service with coalescing and an optional short TTL. */
export class ImoOverviewService extends Service implements ImoOverview {
  static inject = ["imoCli", "imoAuth", "imoSkills", "imoSkillActivation", "operationLog"];
  static Config = Config;

  #dependencies: OverviewDependencies;
  #ttlMs: number;
  #cached: { readonly at: number; readonly view: ImoOverviewView } | undefined;
  #inflight: Promise<ImoOverviewView> | undefined;
  #lastImo: ImoOverviewView["imo"] | undefined;
  #lastSkills: ImoOverviewView["skills"] | undefined;
  #lastAuth: ImoOverviewView["auth"] | undefined;
  #disposed = false;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoOverview");
    const resolved = resolveConfig(config);
    this.#ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, resolved.overviewTtlMs));
    this.#dependencies = {
      imoCli: ctx.get<ImoCli>("imoCli")!,
      imoAuth: ctx.get<ImoAuth>("imoAuth")!,
      imoSkills: ctx.get<ImoSkills>("imoSkills")!,
      imoSkillActivation: ctx.get<ImoSkillActivation>("imoSkillActivation")!,
      operationLog: ctx.get<OperationLogLike>("operationLog")!,
      imoUpgrade: ctx.get<{ upgradeStatus(): { running: boolean } }>("imoUpgrade"),
    };
    this.snapshot = this.snapshot.bind(this);
    this.snapshotFast = this.snapshotFast.bind(this);
    this.ctx.effect(() => () => {
      this.#disposed = true;
      this.#cached = undefined;
      this.#inflight = undefined;
    }, "imoOverview.state");
  }

  async snapshot(signal?: AbortSignal): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    if (signal === undefined && this.#ttlMs > 0 && this.#cached !== undefined) {
      if (Date.now() - this.#cached.at <= this.#ttlMs) return this.#cached.view;
    }
    const existing = this.#inflight;
    if (existing !== undefined) return existing;
    const inflight = buildOverview(this.#dependencies, signal).then(async (view) => {
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
      this.#lastImo = view.imo;
      this.#lastSkills = view.skills;
      this.#lastAuth = view.auth;
      this.#inflight = undefined;
      this.#cached = { at: Date.now(), view: enriched };
      return enriched;
    }, (error) => {
      this.#inflight = undefined;
      throw error;
    });
    this.#inflight = inflight;
    return inflight;
  }

  async snapshotFast(signal?: AbortSignal): Promise<ImoOverviewView> {
    if (this.#disposed || signal?.aborted) return this.cancelledView();
    // Cold start: warm the full projections in the background so the next
    // fast snapshot carries version/skills data; this call still answers
    // immediately with the degraded sections.
    if (this.#lastImo === undefined) void this.snapshot().catch(() => undefined);
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
    const fast = await this.#dependencies.imoAuth.profilesFast(signal).catch(() => undefined);
    if (fast !== undefined && fast.ok) {
      const profiles = fast.value.profiles.slice(0, 100).map(profile => Object.freeze({
        name: profile.profileName,
        ...(profile.env === undefined ? {} : { env: profile.env }),
        ...(profile.tenantCode === undefined ? {} : { tenantCode: profile.tenantCode }),
        ...(profile.accountName === undefined ? {} : { account: profile.accountName }),
        isDefault: profile.isDefault === true,
      }));
      const defaultProfile = fast.value.defaultProfile ?? undefined;
      return Object.freeze({
        status: "ok",
        ...(fast.value.stale ? { code: "stale" } : {}),
        profiles,
        count: profiles.length,
        ...(defaultProfile === undefined ? {} : { defaultProfile, defaultProfileName: defaultProfile }),
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
