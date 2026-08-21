import { IcomposerReferenceService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  IcomposerReferenceFace,
  ReferenceErrorCode,
  Result,
  SdkClientSummary,
  SdkClientsResult,
  SdkOperation,
  SdkQueryInput,
  SdkQueryResult,
  UtilMethod,
  UtilMethodsResult,
  UtilQueryInput,
  UtilSummary,
  UtilsResult,
} from "./types.ts";

export type {
  IcomposerReferenceFace,
  ReferenceErrorCode,
  Result,
  SdkClientSummary,
  SdkClientsResult,
  SdkOperation,
  SdkQueryInput,
  SdkQueryResult,
  UtilMethod,
  UtilMethodsResult,
  UtilQueryInput,
  UtilSummary,
  UtilsResult,
};

export const name = "@icomposer/icomposer-reference";
export const inject = ["workspaceBinding"] as const;

export function apply(ctx: Context): void {
  ctx.plugin(IcomposerReferenceService);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerReference: IcomposerReferenceFace;
  }
}
