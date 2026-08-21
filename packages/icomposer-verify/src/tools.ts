import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { registerIcomposerToolsWith } from "./tool-defs.ts";

/**
 * Register the three read-only iComposer Agent tools using the host
 * `defineTool` factory. @returns one disposer per registered tool.
 */
export function registerIcomposerTools(ctx: Context): Array<() => void> {
  return registerIcomposerToolsWith(ctx, defineTool as never);
}
