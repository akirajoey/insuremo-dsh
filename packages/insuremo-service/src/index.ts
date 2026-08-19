import type { Context } from "@deepseek-ai/cordis";
import { resolveConfig, type Config as ImoConfig } from "./config.ts";
import { ImoCliService } from "./cli.ts";
import { ImoUpgradeService } from "./upgrade.ts";
import { ImoSkillsService } from "./skills.ts";
import { ImoAuthService } from "./auth/index.ts";
import type { ImoCli } from "./cli.ts";
import type { ImoUpgrade } from "./upgrade.ts";
import type { ImoSkills } from "./skills.ts";
import type { ImoAuth } from "./auth/index.ts";
import type { OperationLogLike } from "./operation-log-face.ts";

export { Config, DEFAULT_SMOKE_COMMANDS, resolveConfig } from "./config.ts";
export * from "./cli.ts";
export * from "./upgrade.ts";
export * from "./skills.ts";
export * from "./auth/index.ts";
export type {
  ImoCliError,
  ImoCliErrorCode,
  ImoResult,
} from "./run.ts";

/** Services required by this Host-only package. */
export const inject = ["subprocess", "operationLog"];

/** Loader-facing plugin name. */
export const name = "@icomposer/insuremo-service";

export { ImoCliService, ImoUpgradeService, ImoSkillsService, ImoAuthService };

// Cordis context faces stay declared at the composition boundary so each
// domain module remains independent of the barrel and there are no cycles.
declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
    imoUpgrade: ImoUpgrade;
    imoSkills: ImoSkills;
    imoAuth: ImoAuth;
    operationLog: OperationLogLike;
  }
}

/** Mount all Host service fibers; the package-level config is loader-optional. */
export function apply(ctx: Context, config: Partial<ImoConfig> = {}): void {
  const merged = resolveConfig(config);
  ctx.plugin(ImoCliService, merged);
  ctx.plugin(ImoUpgradeService, merged as never);
  ctx.plugin(ImoSkillsService, merged);
  ctx.plugin(ImoAuthService, merged);
}

export default ImoCliService;
