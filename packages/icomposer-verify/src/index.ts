import { IcomposerVerifyService } from "./service.ts";
import { IcomposerVerifyToolService } from "./tool-service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  IcomposerVerifyFace,
  SearchMatch,
  UtilClassSummary,
  UtilsListView,
  UtilsSearchView,
  VerifyErrorCode,
  VerifyIssue,
  VerifyReportView,
  VerifyUsage,
  VerifyUtilsInput,
} from "./types.ts";

export { IciContextService, ICI_CONTEXT_PLUGIN, ICI_CONTEXT_POLICY_VERSION } from "./ici-context-service.ts";
export { registerIcomposerTools } from "./tools.ts";
export { IcomposerVerifyToolService } from "./tool-service.ts";
export type {
  IcomposerVerifyFace,
  SearchMatch,
  UtilClassSummary,
  UtilsListView,
  UtilsSearchView,
  VerifyErrorCode,
  VerifyIssue,
  VerifyReportView,
  VerifyUsage,
  VerifyUtilsInput,
};

export const name = "@icomposer/icomposer-verify";
export const inject = ["subprocess", "workspaceBinding", "imoAuth", "tools", "systemPrompt"] as const;

export function apply(ctx: Context, config: unknown = {}): void {
  // Keep both the face and tool registrations persistent for standalone
  // package mounts; aggregate mounts may additionally order these services.
  ctx.plugin(IcomposerVerifyService, config);
  ctx.plugin(IcomposerVerifyToolService, config);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerVerify: IcomposerVerifyFace;
  }
}
