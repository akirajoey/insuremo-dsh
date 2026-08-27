import { IciEngineService, ICI_ENGINE_VERSION } from "./service.ts";
import { ExplainScheduler } from "./explain-scheduler.ts";
import { ExplainRoutesService, EXPLAIN_ROUTES_PREFIX } from "./explain-routes.ts";
import type { ExplainBatchRecord, ExplainJobInput, ExplainJobRecord, ExplainReferenceTarget, ExplainReferenceTargetKind } from "./explain-artifacts.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CleanupApplyResult,
  CleanupPlan,
  DiagnosticsResult,
  IciBuildResult,
  ExplainPrepareBatchResult,
  IciEdge,
  IciEngineFace,
  IciManifest,
  IciNode,
  ProgressCallback,
  Result,
  SearchIndexResult,
  SearchResult,
} from "./types.ts";

export { ExplainRoutesService, EXPLAIN_ROUTES_PREFIX, ExplainScheduler, ICI_ENGINE_VERSION };
export { normalizeNativePickedTarget } from "./explain-routes.ts";
export { pickNativeFile } from "./native-picker.ts";
export type { ExplainRoutesConfig, NativeFilePicker } from "./explain-routes.ts";
export type { NativeCommandRunner, NativeFilePickerInternals, NativePickerKind } from "./native-picker.ts";
export type {
  CleanupApplyResult,
  CleanupPlan,
  DiagnosticsResult,
  IciBuildResult,
  ExplainPrepareBatchResult,
  IciEdge,
  IciEngineFace,
  IciManifest,
  IciNode,
  ProgressCallback,
  Result,
  SearchIndexResult,
  SearchResult,
  ExplainBatchRecord,
  ExplainJobInput,
  ExplainJobRecord,
  ExplainReferenceTarget,
  ExplainReferenceTargetKind,
};

export const name = "@icomposer/icomposer-code-intelligence";
export const inject = ["workspaceBinding", "icomposerCatalog", "imoAuth", "jobs", "webServer", "llm", "agents"] as const;

export function apply(ctx: Context): void {
  ctx.plugin(IciEngineService);
  ctx.plugin(ExplainScheduler);
  ctx.plugin(ExplainRoutesService);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    iciEngine: IciEngineFace;
  }
}
