import type { Context } from "@deepseek-ai/cordis";
import { resolveConfig, type Config as ImoConfig } from "./config.ts";
import { ImoCliService } from "./cli.ts";
import { ImoUpgradeService } from "./upgrade.ts";
import { ImoSkillsService } from "./skills.ts";
import { ImoSkillActivationService } from "./skill-activation.ts";
import { ImoOverviewService } from "./overview/service.ts";
import { mountOverviewRoute } from "./overview/route.ts";
import { mountWriteRoutes } from "./overview/write-routes.ts";
import { mountWorkspacesStatusRoute } from "./overview/workspaces-status.ts";
import { mountCurrentProfileSection } from "./current-profile-section.ts";
import { mountInsuremoSkillProvider } from "./skill-provider.ts";
import { ImoAuthService, ImoAuthActionsService } from "./auth/index.ts";
import { ImoSkillActionsService } from "./skill-actions/service.ts";
import type { ImoCli } from "./cli.ts";
import type { ImoUpgrade } from "./upgrade.ts";
import type { ImoSkills } from "./skills.ts";
import type { ImoSkillActivation, SkillActivationController } from "./skill-activation.ts";
import type { ImoOverview } from "./overview/service.ts";
import type { ImoSkillActions } from "./skill-actions/types.ts";
import type { ImoAuth, ImoAuthActions } from "./auth/index.ts";
import type { OperationLogLike } from "./operation-log-face.ts";

export { Config, DEFAULT_SMOKE_COMMANDS, resolveConfig } from "./config.ts";
export * from "./cli.ts";
export * from "./upgrade.ts";
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
export type { ImoOverview } from "./overview/service.ts";
export { OVERVIEW_PATH } from "./overview/service.ts";
export * from "./overview/types.ts";
export {
  INSUREMO_SKILL_CATALOG_INVALIDATE_EVENT,
  INSUREMO_SKILL_PROVIDER,
  INSUREMO_SKILL_RANK,
  INSUREMO_SKILL_SOURCE,
  invalidateInsuremoSkillCatalog,
} from "./skill-provider.ts";
export * from "./auth/index.ts";
export type {
  ImoCliError,
  ImoCliErrorCode,
  ImoResult,
} from "./run.ts";

/** Services required by this Host-only package. */
export const inject = ["subprocess", "operationLog", "skills", "storageDomain", "webServer"];

/** Loader-facing plugin name. */
export const name = "@icomposer/insuremo-service";

export { ImoCliService, ImoUpgradeService, ImoSkillsService, ImoAuthService, ImoAuthActionsService, ImoOverviewService };

// Cordis context faces stay declared at the composition boundary so each
// domain module remains independent of the barrel and there are no cycles.
declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
    imoUpgrade: ImoUpgrade;
    imoSkills: ImoSkills;
    imoSkillActivation: ImoSkillActivation;
    imoSkillActions: ImoSkillActions;
    imoOverview: ImoOverview;
    imoAuth: ImoAuth;
    imoAuthActions: ImoAuthActions;
    operationLog: OperationLogLike;
  }
}

/** Mount all Host service fibers; the package-level config is loader-optional. */
export function apply(ctx: Context, config: Partial<ImoConfig> = {}): void {
  const merged = resolveConfig(config);
  ctx.plugin(ImoCliService, merged);
  ctx.plugin(ImoUpgradeService, merged as never);
  ctx.plugin(ImoSkillsService, merged);
  let actionsMounted = false;
  let activationController: SkillActivationController | undefined;
  ctx.plugin(ImoSkillActivationService, {
    onController: (controller: SkillActivationController) => {
      activationController = controller;
      if (actionsMounted) return;
      actionsMounted = true;
      ctx.plugin(ImoSkillActionsService, merged as never);
    },
  });
  ctx.plugin(ImoAuthService, merged);
  ctx.plugin(ImoAuthActionsService, merged);
  ctx.plugin(ImoOverviewService, merged as never);
  ctx.effect(() => mountOverviewRoute(ctx), "insuremo-overview-route");
  ctx.effect(() => mountWriteRoutes(ctx, { getActivationController: () => activationController }), "insuremo-write-routes");
  ctx.effect(() => mountWorkspacesStatusRoute(ctx), "insuremo-workspaces-status-route");
  ctx.effect(() => mountCurrentProfileSection(ctx), "insuremo-current-profile-section");
  ctx.effect(() => mountInsuremoSkillProvider(ctx), "insuremo-skill-provider");
}

export default ImoCliService;
