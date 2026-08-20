import type { Context } from "@deepseek-ai/cordis";
import { resolveConfig, type Config as ImoConfig } from "./config.ts";
import { ImoCliService } from "./cli.ts";
import { ImoUpgradeService } from "./upgrade.ts";
import { ImoSkillsService } from "./skills.ts";
import { ImoSkillActivationService } from "./skill-activation.ts";
import { mountInsuremoSkillProvider } from "./skill-provider.ts";
import { ImoAuthService, ImoAuthActionsService } from "./auth/index.ts";
import type { ImoCli } from "./cli.ts";
import type { ImoUpgrade } from "./upgrade.ts";
import type { ImoSkills } from "./skills.ts";
import type { ImoSkillActivation, SkillActivationController } from "./skill-activation.ts";
import type { ImoAuth, ImoAuthActions } from "./auth/index.ts";
import type { OperationLogLike } from "./operation-log-face.ts";

export { Config, DEFAULT_SMOKE_COMMANDS, resolveConfig } from "./config.ts";
export * from "./cli.ts";
export * from "./upgrade.ts";
export * from "./skills.ts";
export type { ImoSkillActivation, ImoSkillActivationSnapshot } from "./skill-activation.ts";
export { SKILL_ACTIVATION_CHANGED_EVENT, SKILL_ACTIVATION_DOMAIN_NAME } from "./skill-activation.ts";
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
export const inject = ["subprocess", "operationLog", "skills", "storageDomain"];

/** Loader-facing plugin name. */
export const name = "@icomposer/insuremo-service";

export { ImoCliService, ImoUpgradeService, ImoSkillsService, ImoAuthService, ImoAuthActionsService };

// Cordis context faces stay declared at the composition boundary so each
// domain module remains independent of the barrel and there are no cycles.
declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
    imoUpgrade: ImoUpgrade;
    imoSkills: ImoSkills;
    imoSkillActivation: ImoSkillActivation;
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
  let activationController: SkillActivationController | undefined;
  ctx.plugin(ImoSkillActivationService, {
    onController: (controller: SkillActivationController) => { activationController = controller; },
  });
  // Future approved action mounts close over this capability; it never enters ctx.
  void activationController;
  ctx.plugin(ImoAuthService, merged);
  ctx.plugin(ImoAuthActionsService, merged);
  ctx.effect(() => mountInsuremoSkillProvider(ctx), "insuremo-skill-provider");
}

export default ImoCliService;
