import { IcomposerWriteService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AssetJoinState,
  IcomposerWriteFace,
  PushChoice,
  PushCompileChecks,
  PushErrorCode,
  PushExecution,
  PushFilePreview,
  PushKind,
  PushMode,
  PushPreviewInput,
  PushPreviewView,
  PushReceipt,
  PushRequestInput,
  PushRequestView,
  PushResolveInput,
  PushResolveResult,
  PushResolveView,
  PushStatusView,
  ReleaseApplyInput,
  ReleaseApplyView,
  ReleaseBranchView,
  ReleaseExecution,
  ReleasePreviewInput,
  ReleasePreviewView,
  ReleaseReceipt,
  ReleaseRepoView,
  Result,
  TestEvidence,
  TestExecution,
  TestKind,
  TestReceipt,
  TestRunInput,
  TestRunView,
} from "./types.ts";

export type {
  AssetJoinState,
  IcomposerWriteFace,
  PushChoice,
  PushCompileChecks,
  PushErrorCode,
  PushExecution,
  PushFilePreview,
  PushKind,
  PushMode,
  PushPreviewInput,
  PushPreviewView,
  PushReceipt,
  PushRequestInput,
  PushRequestView,
  PushResolveInput,
  PushResolveResult,
  PushResolveView,
  PushStatusView,
  ReleaseApplyInput,
  ReleaseApplyView,
  ReleaseBranchView,
  ReleaseExecution,
  ReleasePreviewInput,
  ReleasePreviewView,
  ReleaseReceipt,
  ReleaseRepoView,
  Result,
  TestEvidence,
  TestExecution,
  TestKind,
  TestReceipt,
  TestRunInput,
  TestRunView,
};
export { assetJoinState } from "./join-check.ts";
export { readTestArtifact, writeBaseDir } from "./artifacts.ts";

/** Loader-facing plugin name. */
export const name = "@icomposer/icomposer-write";
/** Host-only; the operation log must be present for receipted writes. */
export const inject = ["subprocess", "workspaceBinding", "imoAuth", "operationLog"] as const;

/** Loader entry point. */
export function apply(ctx: Context, config: unknown = {}): void {
  ctx.plugin(IcomposerWriteService, config);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerWrite: IcomposerWriteFace;
  }
}
