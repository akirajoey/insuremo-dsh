import { IciEngineService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CleanupApplyResult,
  CleanupPlan,
  DiagnosticsResult,
  IciBuildResult,
  IciEdge,
  IciEngineFace,
  IciManifest,
  IciNode,
  ProgressCallback,
  Result,
  SearchIndexResult,
  SearchResult,
} from "./types.ts";

export type {
  CleanupApplyResult,
  CleanupPlan,
  DiagnosticsResult,
  IciBuildResult,
  IciEdge,
  IciEngineFace,
  IciManifest,
  IciNode,
  ProgressCallback,
  Result,
  SearchIndexResult,
  SearchResult,
};

export const name = "@icomposer/icomposer-code-intelligence";
export const inject = ["workspaceBinding", "icomposerCatalog", "imoAuth", "jobs"] as const;

export function apply(ctx: Context): void {
  ctx.plugin(IciEngineService);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    iciEngine: IciEngineFace;
  }
}
