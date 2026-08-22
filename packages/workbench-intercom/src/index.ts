import { applyIntercom } from "./provider.ts";
import type { IntercomContext } from "./types.ts";

export * from "./domain.ts";
export * from "./provider.ts";
export * from "./store.ts";
export * from "./types.ts";

/** Loader-facing plugin name. */
export const name = "@icomposer/workbench-intercom";
/** The storage-domain facility must be available before opening our domain. */
export const inject = ["storageDomain"] as const;

/** Loader entry point. */
export function apply(ctx: IntercomContext): Promise<void> {
  return applyIntercom(ctx);
}
