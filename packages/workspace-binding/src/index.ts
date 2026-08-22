import { WorkspaceBindingService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { WorkspaceBindingServiceFace } from "./service.ts";

/** Loader-facing plugin name. */
export const name = "@icomposer/workspace-binding";
/** Hard inject: storageDomain and workspaceRegistry must be present. */
export const inject = ["storageDomain", "workspaceRegistry"] as const;

/** Loader entry point. */
export function apply(ctx: Context): void {
  ctx.plugin(WorkspaceBindingService);
}

// Public surface: only name/inject/apply + face/input/view/result/error types/constants
export type { WorkspaceBindingServiceFace, BindingView, WorkspaceListEntry, BindInput, UnbindInput, Result, BindingErrorCode } from "./service.ts";
export { WORKSPACE_BINDING_ERRORS } from "./service.ts";
export { detectIcomposerProject, deriveBindIdentity } from "./detect.ts";
export { mountAutoBind, WORKSPACE_ICOMPOSER_AUTO_BOUND_EVENT, type AutoBindModule, type AutoBindState } from "./auto-bind.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    workspaceBinding: WorkspaceBindingServiceFace;
  }
}
