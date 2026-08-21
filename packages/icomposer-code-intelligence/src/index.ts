import { IciEngineService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { IciBuildResult, IciEdge, IciEngineFace, IciManifest, IciNode, ProgressCallback, Result } from "./types.ts";

export type {
  IciBuildResult,
  IciEdge,
  IciEngineFace,
  IciManifest,
  IciNode,
  ProgressCallback,
  Result,
};

export const name = "@icomposer/icomposer-code-intelligence";
export const inject = ["workspaceBinding", "icomposerCatalog"] as const;

export function apply(ctx: Context): void {
  ctx.plugin(IciEngineService);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    iciEngine: IciEngineFace;
  }
}
