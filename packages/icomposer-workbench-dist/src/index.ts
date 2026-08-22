/**
 * Host aggregate entry for the distributable `@icomposer/workbench` plugin.
 *
 * Mounts the ten Workbench host packages in dependency order (operation
 * log and workspace binding first — everything else injects their services;
 * the write path mounts after code-intelligence and before intercom; the
 * interactive test plugin is intentionally not part of the product).
 * Each sub-plugin keeps its own `inject` contract; this entry's exported
 * `inject` is the union so the loader guarantees every dependency is live
 * before the first `apply` runs.
 */
import type { Context } from "@deepseek-ai/cordis";
import * as operationLog from "../../workbench-operation-log/src/index.ts";
import * as workspaceBinding from "../../workspace-binding/src/index.ts";
import * as catalog from "../../icomposer-catalog/src/index.ts";
import * as reference from "../../icomposer-reference/src/index.ts";
import * as lifecycle from "../../icomposer-lifecycle/src/index.ts";
import * as verify from "../../icomposer-verify/src/index.ts";
import * as codeIntelligence from "../../icomposer-code-intelligence/src/index.ts";
import * as write from "../../icomposer-write/src/index.ts";
import * as intercom from "../../workbench-intercom/src/index.ts";
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
] as const;

/** Per-package config overrides keyed by package id (all optional). */
export interface WorkbenchDistConfig {
  readonly lifecycle?: unknown;
  readonly verify?: unknown;
  readonly write?: unknown;
  readonly insuremoService?: unknown;
}

/** Mount order: registries first, then readers, then writers, then the service. */
export async function apply(ctx: Context, config: WorkbenchDistConfig = {}): Promise<void> {
  await ctx.plugin(operationLog as never);
  await ctx.plugin(workspaceBinding as never);
  await ctx.plugin(catalog as never);
  await ctx.plugin(reference as never);
  await ctx.plugin(lifecycle as never, config.lifecycle);
  await ctx.plugin(verify as never, config.verify);
  await ctx.plugin(codeIntelligence as never);
  await ctx.plugin(write as never, config.write);
  await ctx.plugin(intercom as never);
  await ctx.plugin(insuremoService as never, config.insuremoService);
}
