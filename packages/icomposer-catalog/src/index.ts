import { IcomposerCatalogService } from "./service.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AssetCatalog,
  AssetEntry,
  AssetType,
  CatalogErrorCode,
  IcomposercCatalogFace,
  JoinStatus,
  ListAssetsInput,
  Result,
} from "./types.ts";

export type {
  AssetCatalog,
  AssetEntry,
  AssetType,
  CatalogErrorCode,
  IcomposercCatalogFace,
  JoinStatus,
  ListAssetsInput,
  Result,
};

export const name = "@icomposer/icomposer-catalog";
export const inject = ["workspaceBinding"] as const;

export function apply(ctx: Context): void {
  ctx.plugin(IcomposerCatalogService);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    icomposerCatalog: IcomposercCatalogFace;
  }
}
