import { IcomposerLifecycleService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AssetType,
  IcomposerLifecycleFace,
  InitPreviewGroup,
  InitPreviewGroupsView,
  InitPreviewInput,
  InitPreviewPlanView,
  InitPreviewView,
  JoinSample,
  LifecycleErrorCode,
  ReloadPreviewView,
  Result,
} from "./types.ts";

export type {
  AssetType,
  IcomposerLifecycleFace,
  InitPreviewGroup,
  InitPreviewGroupsView,
  InitPreviewInput,
  InitPreviewPlanView,
  InitPreviewView,
  JoinSample,
  LifecycleErrorCode,
  ReloadPreviewView,
  Result,
};

export const name = "@icomposer/icomposer-lifecycle";
export const inject = ["subprocess", "workspaceBinding", "imoAuth"] as const;

export function apply(ctx: Context, config: unknown = {}): void {
  ctx.plugin(IcomposerLifecycleService, config);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerLifecycle: IcomposerLifecycleFace;
  }
}
