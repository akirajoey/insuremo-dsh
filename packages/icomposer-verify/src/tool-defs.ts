import type { Context } from "@deepseek-ai/cordis";
import { registerIciTools } from "./ici-tools.ts";
import { registerIciSearchTool } from "./ici-search-tool.ts";

interface ToolTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface ToolExecContext {
  readonly signal: AbortSignal;
}

/** Minimal structural type of the host `defineTool` factory (dsh-tools). */
export type DefineToolFn = (options: Record<string, unknown>) => unknown;

type ResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface CatalogFace {
  listAssets(input: { workspaceId: string; type?: string }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { api: number; function: number; batch: number; model: number; total: number };
    truncated: boolean;
    entries: readonly { readonly name: string; readonly type: string; readonly joinStatus: string }[];
  }>>;
}

interface ReferenceFace {
  querySdkOperations(input: { workspaceId: string; client?: string; keyword?: string; limit?: number }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { clients: number; operations: number };
    truncated: boolean;
    operations: readonly { readonly client: string; readonly method: string; readonly path: string; readonly operationId: string }[];
  }>>;
}

interface VerifyFace {
  listUtils(input: { workspaceId: string }, signal?: AbortSignal): Promise<ResultLike<{
    classes: readonly { readonly className: string; readonly methodCount: number; readonly description?: string }[];
    count: number;
    truncated: boolean;
  }>>;
  searchUtils(input: { workspaceId: string; keyword: string }, signal?: AbortSignal): Promise<ResultLike<{
    matches: readonly { readonly className: string; readonly method?: string; readonly description?: string }[];
    count: number;
    truncated: boolean;
  }>>;
}

/** Flattened tree line for canonical output/render. */
interface IciTreeLine {
  readonly depth: number;
  readonly label: string;
}

const TOOL_ENTRY_LIMIT = 50;

function clipEntries<T>(items: readonly T[]): T[] {
  return items.slice(0, TOOL_ENTRY_LIMIT);
}


function objectSchema2(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function errorText(code: string): string {
  return `icomposer tools error: ${code}`;
}

/**
 * Read-only Agent tools over the workbench iComposer faces. Every tool is
 * concurrency-safe and side-effect free; failures surface as structured
 * `{ error: { code } }` outputs (fixed codes), never raw CLI output.
 * Takes the host `defineTool` factory as a parameter so this module stays
 * free of the host tools runtime at test time.
 * @returns one disposer per registered tool (unregister on scope exit).
 */
export function registerIcomposerToolsWith(ctx: Context, defineTool: DefineToolFn): Array<() => void> {
  const disposers: Array<() => void> = [];
  ctx.systemPrompt.section({
    name: "tool:icomposer_catalog_list",
    order: 150,
    text: "icomposer_catalog_list lists the local iComposer asset catalog of a bound workspace (api/function/batch/model, join status vs server metadata). Read-only: it never writes files.",
  });
  ctx.systemPrompt.section({
    name: "tool:icomposer_sdk_query",
    order: 150,
    text: "icomposer_sdk_query searches SDK client operations of a bound workspace by client name or keyword. Read-only: it never writes files.",
  });
  ctx.systemPrompt.section({
    name: "tool:icomposer_verify_utils",
    order: 150,
    text: "icomposer_verify_utils lists utility classes or searches utility methods of a bound workspace. Read-only: it never writes files.",
  });

  disposers.push(...registerIciTools(ctx, defineTool as never));
  disposers.push(...registerIciSearchTool(ctx, defineTool as never));
  return disposers;
}
