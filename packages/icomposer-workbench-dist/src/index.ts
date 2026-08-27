/**
 * Host aggregate entry for the distributable `@icomposer/workbench` plugin.
 *
 * The entry is a Service (not a bare function-apply): loader-mounted function
 * plugins run their `apply` in a transient fiber whose effects are disposed
 * once the call resolves — route registrations and child-plugin mounts made
 * there vanish ~30ms later (observed as overview 404 with a clean boot). A
 * Service keeps a persistent fiber: everything mounted in `[Service.init]`
 * lives for the plugin's lifetime.
 *
 * Mount order (P0 fix): insuremo-service FIRST — it provides `imoAuth`
 * (plus imoCli/imoSkills/imoOverview and the write-bridge routes) and only
 * depends on Harness services already in the inject union. The packages that
 * inject `imoAuth` (lifecycle/verify/code-intelligence/write) mount after it,
 * so their sequential awaits resolve instead of deadlocking.
 * operationLog/workspaceBinding/catalog follow (write needs operationLog,
 * code-intelligence needs the catalog), then the remaining readers. The
 * interactive test plugin is intentionally excluded.
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import * as operationLog from "../../workbench-operation-log/src/index.ts";
import * as workspaceBinding from "../../workspace-binding/src/index.ts";
import * as catalog from "../../icomposer-catalog/src/index.ts";
import * as reference from "../../icomposer-reference/src/index.ts";
import * as lifecycle from "../../icomposer-lifecycle/src/index.ts";
import { IcomposerVerifyService } from "../../icomposer-verify/src/service.ts";
import { IcomposerVerifyToolService } from "../../icomposer-verify/src/tool-service.ts";
import { IciContextService } from "../../icomposer-verify/src/ici-context-service.ts";
import { IciEngineService } from "../../icomposer-code-intelligence/src/service.ts";
import { ExplainScheduler } from "../../icomposer-code-intelligence/src/explain-scheduler.ts";
import { ExplainRoutesService } from "../../icomposer-code-intelligence/src/explain-routes.ts";
import * as write from "../../icomposer-write/src/index.ts";
import * as insuremoService from "../../insuremo-service/src/index.ts";

/** Loader-facing plugin name (the distributable package identity). */
export const name = "@icomposer/workbench";

/** Union of every sub-plugin's inject — the loader provides them all up front. */
export const inject = [
  "subprocess",
  "storageDomain",
  "workspaceRegistry",
  "skills",
  "webServer",
  "tools",
  "jobs",
  "llm",
  "agents",
  "directoryPicker",
  "systemPrompt",
] as const;

/** Per-package config overrides keyed by package id (all optional). */
export interface WorkbenchDistConfig {
  readonly lifecycle?: unknown;
  readonly verify?: unknown;
  readonly write?: unknown;
  readonly insuremoService?: unknown;
}

/**
 * Aggregate mount service: the service shell first (imoAuth + faces + routes),
 * then registries, then the imoAuth-injecting readers/writers.
 */
export class WorkbenchDistService extends Service {
  constructor(ctx: Context, config: WorkbenchDistConfig = {}) {
    super(ctx, "@icomposer/workbench");
    this.#config = config;
  }

  readonly #config: WorkbenchDistConfig;

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx;
    await ctx.plugin(insuremoService as never, this.#config.insuremoService);
    await ctx.plugin(operationLog as never);
    await ctx.plugin(workspaceBinding as never);
    await ctx.plugin(catalog as never);
    await ctx.plugin(reference as never);
    await ctx.plugin(lifecycle as never, this.#config.lifecycle);
    await ctx.plugin(IcomposerVerifyService as never, this.#config.verify);
    await ctx.plugin(IciContextService as never);
    await ctx.plugin(IciEngineService as never);
    await ctx.plugin(ExplainScheduler as never);
    await ctx.plugin(ExplainRoutesService as never);
    await ctx.plugin(IcomposerVerifyToolService as never);
    await ctx.plugin(write as never, this.#config.write);
  }
}

export default WorkbenchDistService;
