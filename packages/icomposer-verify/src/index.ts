import { IcomposerVerifyService } from "./service.ts";
import { registerIcomposerTools } from "./tools.ts";
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
export const inject = ["subprocess", "workspaceBinding", "imoAuth", "tools"] as const;

export function apply(ctx: Context, config: unknown = {}): void {
  ctx.plugin(IcomposerVerifyService, config);
  // Register at mount; `tools.register` hands back the exact unregister
  // disposer, so scope exit removes the three tools again.
  ctx.effect(() => {
    const disposers = registerIcomposerTools(ctx);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "icomposerVerify.tools");
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerVerify: IcomposerVerifyFace;
  }
}
