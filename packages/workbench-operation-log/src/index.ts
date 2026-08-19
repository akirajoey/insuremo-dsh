import { applyOperationLog } from "./provider.ts";
import type { OperationLogContext } from "./types.ts";

export * from "./domain.ts";
export * from "./error.ts";
export * from "./provider.ts";
export * from "./types.ts";

/** Loader-facing plugin name. */
export const name = "@icomposer/workbench-operation-log";
/** The storage-domain form must be available before opening our domain. */
export const inject = ["storageDomain"];

/** Loader entry point. */
export function apply(ctx: OperationLogContext): Promise<void> {
  return applyOperationLog(ctx);
}
