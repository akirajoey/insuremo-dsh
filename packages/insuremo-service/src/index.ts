import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { resolveConfig, type Config as ImoConfig } from "./config.ts";
import { ImoCliService } from "./cli.ts";
import { ImoUpgradeService } from "./upgrade.ts";
import { ImoInstallService } from "./imo-install.ts";
import { ImoSkillsService } from "./skills.ts";
import { ImoSkillActivationService } from "./skill-activation.ts";
import { ImoOverviewService } from "./overview/service.ts";
import { InsuremoRoutesService, setActivationControllerOnContext } from "./overview/route-service.ts";
import { InsuremoSkillProviderService } from "./skill-provider-service.ts";
import { InsuremoAgentSkillMaskService } from "./skill-agent-mask-service.ts";
import { ImoProfileContextService } from "./profile-context.ts";
import { ImoAuthService, ImoAuthActionsService } from "./auth/index.ts";
import { ImoActiveProfileService } from "./active-profile.ts";
import { ImoSkillActionsService } from "./skill-actions/service.ts";
import type { ImoCli } from "./cli.ts";
import type { ImoUpgrade } from "./upgrade.ts";
import type { ImoInstall } from "./imo-install.ts";
import type { ImoSkills } from "./skills.ts";
import type { ImoSkillActivation, SkillActivationController } from "./skill-activation.ts";
import type { ImoOverview } from "./overview/service.ts";
import type { ImoSkillActions } from "./skill-actions/types.ts";
import type { ImoAuth, ImoAuthActions } from "./auth/index.ts";
import type { OperationLogLike } from "./operation-log-face.ts";

export { Config, DEFAULT_SMOKE_COMMANDS, resolveConfig } from "./config.ts";
export * from "./cli.ts";
export * from "./upgrade.ts";
export * from "./imo-install.ts";
export * from "./skills.ts";
export type { ImoSkillActivation, ImoSkillActivationSnapshot } from "./skill-activation.ts";
export type {
  ImoSkillActions,
  SkillActionError,
  SkillActionEvent,
  SkillActionExecution,
  SkillActionInput,
  SkillActionKind,
  SkillActionPreview,
  SkillActionReceipt,
  SkillActionRequest,
  SkillActionResult,
  SkillActionStatus,
} from "./skill-actions/types.ts";
export {
  SKILL_ACTION_COMPLETED_EVENT,
  SKILL_ACTION_FAILED_EVENT,
  SKILL_ACTIVATION_KIND,
  SKILL_INSTALL_KIND,
  SKILL_REMOVE_KIND,
  SKILL_UPDATE_KIND,
} from "./skill-actions/types.ts";
export { SKILL_ACTIVATION_CHANGED_EVENT, SKILL_ACTIVATION_DOMAIN_NAME } from "./skill-activation.ts";
export {
  SKILLS_TOOL_COMMAND,
  SKILLS_TOOL_PACKAGE,
  SKILLS_TOOL_REGISTRY,
  SKILLS_TOOL_SOURCE,
  SKILL_CATALOG_DESCRIPTION_MAX,
  SKILL_CATALOG_MAX_ENTRIES,
  SKILL_CATALOG_OUTPUT_LIMIT_BYTES,
  SKILL_CATALOG_SCHEMA_VERSION,
  SKILL_CATALOG_TTL_MS,
  buildSkillCatalog,
  catalogSkillNames,
  isEmptySkillCatalogOutput,
  parseCatalogOutput,
  parseSkillCatalogOutput,
  skillCatalogArgs,
} from "./skill-actions/index.ts";
export type { SkillCatalogEntry, SkillCatalogScenario, SkillCatalogSkill, SkillCatalogSnapshot } from "./skill-actions/catalog.ts";
export type { ImoOverview } from "./overview/service.ts";
export { OVERVIEW_PATH } from "./overview/service.ts";
export { SKILL_CATALOG_PATH } from "./overview/paths.ts";
export * from "./overview/types.ts";
export {
  INSUREMO_SKILL_CATALOG_INVALIDATE_EVENT,
  INSUREMO_SKILL_PROVIDER,
  INSUREMO_SKILL_RANK,
  INSUREMO_SKILL_SOURCE,
  invalidateInsuremoSkillCatalog,
} from "./skill-provider.ts";
export * from "./auth/index.ts";
export { ImoActiveProfileService, activeProfileDomain, ACTIVE_PROFILE_CHANGED_EVENT } from "./active-profile.ts";
export type { ImoActiveProfile, ActiveProfileView, ActiveProfileResult, ActiveProfileStatus } from "./active-profile.ts";
export type {
  ImoCliError,
  ImoCliErrorCode,
  ImoResult,
} from "./run.ts";

/** Services required by the full multi-service mount (see `insuremoServiceMount`). */
const MOUNT_INJECT = ["subprocess", "operationLog", "skills", "storageDomain", "workspaceRegistry", "webServer", "agents"] as const;

/** Loader-facing plugin name of the full multi-service mount. */
const MOUNT_NAME = "@icomposer/insuremo-service";

export { ImoCliService, ImoUpgradeService, ImoInstallService, ImoSkillsService, ImoAuthService, ImoAuthActionsService, ImoOverviewService, InsuremoSkillProviderService, InsuremoAgentSkillMaskService, ImoProfileContextService };

// Cordis context faces stay declared at the composition boundary so each
// domain module remains independent of the barrel and there are no cycles.
declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
    imoUpgrade: ImoUpgrade;
    imoInstall: ImoInstall;
    imoSkills: ImoSkills;
    imoSkillActivation: ImoSkillActivation;
    imoSkillActions: ImoSkillActions;
    imoOverview: ImoOverview;
    imoAuth: ImoAuth;
    imoAuthActions: ImoAuthActions;
    imoActiveProfile: import("./active-profile.ts").ImoActiveProfile;
    operationLog: OperationLogLike;
  }
}

/**
 * Settings namespace served on the Host so the Plugins settings tab
 * dispatches our card (TASK-039). The card is display + one-shot actions —
 * the schema is a permissive placeholder the card never edits; serving the
 * namespace is what makes the tab pair it with the card.
 */
export const SETTINGS_NAMESPACE = "insuremo" as const;

/** Mount all Host service fibers; the package-level config is loader-optional. */
function mountAll(ctx: Context, config: Partial<ImoConfig> = {}): void {
  // Settings namespace registration: the Plugins card dispatch needs the Host
  // to serve this namespace. The schema is a permissive schemastery shape
  // (settings.register resolves by CALLING the schema — a plain zod-style
  // object throws and the namespace never registers); failures log loud but
  // never affect the service lifecycle.
  (ctx as unknown as { inject(names: readonly string[], callback: (ctx: unknown) => void): unknown }).inject(["settings"], (injected: unknown) => {
    try {
      const settingsCtx = injected as { settings: { register(ns: string, schema: unknown, options?: { base?: unknown }): unknown } };
      settingsCtx.settings.register(SETTINGS_NAMESPACE, z.object({ placeholder: z.string().default("insuremo") }), { base: {} });
    } catch (error) {
      (ctx as unknown as { logger?: { warn(message: string): void } }).logger?.warn(`insuremo settings namespace registration failed: ${String(error)}`);
    }
  });
  const merged = resolveConfig(config);
  mountChild(ctx, "imoCli", ImoCliService, merged);
  mountChild(ctx, "imoUpgrade", ImoUpgradeService, merged as never);
  mountChild(ctx, "imoInstall", ImoInstallService);
  mountChild(ctx, "imoSkills", ImoSkillsService, merged);
  let actionsMounted = false;
  let activationController: SkillActivationController | undefined;
  mountChild(ctx, "routes", InsuremoRoutesService as never);
  mountChild(ctx, "skillActivation", ImoSkillActivationService, {
    onController: (controller: SkillActivationController) => {
      activationController = controller;
      setActivationControllerOnContext(ctx, controller);
      if (actionsMounted) return;
      actionsMounted = true;
      mountChild(ctx, "skillActions", ImoSkillActionsService, merged as never);
    },
  });
  mountChild(ctx, "imoAuth", ImoAuthService, merged);
  mountChild(ctx, "activeProfile", ImoActiveProfileService, {});
  mountChild(ctx, "authActions", ImoAuthActionsService, merged);
  mountChild(ctx, "overview", ImoOverviewService, merged as never);
  // TASK-044 C: mount the provider via a PERSISTENT SERVICE so the
  // rank-0 mask/enabled catalog survives the loader-effect sweep window and
  // controls the real aggregated model-facing catalog.
  mountChild(ctx, "skillProvider", InsuremoSkillProviderService, {
    skillOverlayEnabled: merged.skillOverlayEnabled,
    skillOverlayNames: merged.skillOverlayNames,
  });
  // TASK-045 B: exact-agent rank-0 masks must be mounted through each
  // agent.ctx.skills layer, not merged into the global provider layer.
  mountChild(ctx, "agentSkillMask", InsuremoAgentSkillMaskService, {
    skillOverlayEnabled: merged.skillOverlayEnabled,
    skillOverlayNames: merged.skillOverlayNames,
  });
  // TASK-044 B: independent per-lifecycle profile runtime-context.
  mountChild(ctx, "profileContext", ImoProfileContextService, {});
}

/**
 * Mount one child and make an activation-time failure observable without
 * stopping the other children. These mounts are deliberately not awaited, so
 * `apply()` never stays open on a child whose `inject` is not satisfied yet.
 * That is a bounded observation window, not a blocking composition design: Cordis
 * `Fiber.await()` resolves immediately for a PENDING fiber (there is no
 * in-flight transition to wait on), so a later activation failure is reported
 * by the host's own fiber error log instead of this helper. See
 * `reportChildFailure` for exactly what this package adds.
 */
function mountChild(ctx: Context, label: string, plugin: unknown, config?: unknown): void {
  let fiber: { await(): Promise<unknown> };
  try {
    fiber = (ctx as unknown as { plugin(p: unknown, c?: unknown): { await(): Promise<unknown> } }).plugin(plugin, config);
  } catch (error) {
    reportChildFailure(ctx, label, error);
    return;
  }
  void fiber.await().catch((error: unknown) => reportChildFailure(ctx, label, error));
}

/**
 * Fixed, bounded record for a failure observed while this mount turn settles
 * (a child that fails on the spot or during its first activation). It never
 * includes raw output or credentials. A child that activates only after a
 * later dependency arrives is outside this window: Cordis reports that failure
 * through its own fiber error log, without this label and without this
 * truncation.
 */
function reportChildFailure(ctx: Context, label: string, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const logger = (ctx as unknown as { logger?: { error(format: string, ...args: unknown[]): void } }).logger;
  logger?.error("insuremo-service: child %s failed: %s", label, message);
}

/**
 * Full multi-service mount as an explicit object plugin.
 *
 * The package root keeps a single default export (`ImoCliService`) so the
 * standalone loader entry still selects the CLI-only class. The aggregate
 * imports this object and passes it to `ctx.plugin`, so the root no longer
 * exposes two competing plugin shapes (default class + top-level `apply`).
 */
export const insuremoServiceMount = Object.freeze({
  name: MOUNT_NAME,
  inject: MOUNT_INJECT,
  apply: mountAll,
});

export default ImoCliService;
