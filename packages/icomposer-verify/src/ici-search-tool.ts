import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-defs.ts";

interface ToolExecContext {
  readonly signal: AbortSignal;
}

type ResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface IciSearchRow {
  readonly apiId: string;
  readonly apiName: string;
  readonly score: number;
  readonly evidence: string;
}

interface IciSearchFace {
  search(input: { workspaceId: string; query: string; mode?: "technical" | "business" | "all"; top?: number }, signal?: AbortSignal): Promise<ResultLike<{
    rows: readonly IciSearchRow[];
    truncated: boolean;
    stale?: true;
  }>>;
}

const TOOL_ENTRY_LIMIT = 50;

function clipEntries<T>(items: readonly T[]): T[] {
  return items.slice(0, TOOL_ENTRY_LIMIT);
}

function errorText(code: string): string {
  return `icomposer tools error: ${code}`;
}

function objectSchema2(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

/**
 * Register the read-only iComposer Code Intelligence semantic search Agent
 * tool using the host defineTool factory.
 * @returns one disposer for the registered tool.
 */
export function registerIciSearchTool(ctx: Context, defineTool: DefineToolFn): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.tools.register(defineTool({
    name: "ici_search",
    description: "Semantic search over a bound workspace's API embeddings (iComposer Code Intelligence). Effect: none.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Bound workspace id." },
      query: { type: "string", required: true, description: "Natural-language query text." },
      mode: { type: "string", enum: ["technical", "business", "all"], description: "Which embedding space to score; default all." },
      top: { type: "number", description: "Maximum results (default 10, cap 50)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_id: { type: "string", required: true },
          truncated: { type: "boolean" },
          stale: { type: "boolean" },
          rows: {
            type: "array",
            items: objectSchema2(
              {
                rank: { type: "integer", required: true },
                apiId: { type: "string", required: true },
                apiName: { type: "string", required: true },
                score: { type: "number", required: true },
                evidence: { type: "string" },
              },
              ["rank", "apiId", "apiName", "score"],
            ),
          },
          error: {
            type: "object",
            additionalProperties: false,
            properties: { code: { type: "string", required: true } },
          },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          rows?: readonly { rank: number; apiName: string; score: number }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: errorText(v.error.code) }];
        const lines = [
          `workspace ${v.workspace_id}: ${v.rows?.length ?? 0} results`,
          ...(v.rows ?? []).map(r => `${r.rank}. ${r.apiName} (${r.score.toFixed(4)})`),
        ];
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; query: string; mode?: "technical" | "business" | "all"; top?: number };
      const ici = ctx.get("iciEngine") as unknown as IciSearchFace | undefined;
      if (!ici) return { workspace_id: args.workspace_id, error: { code: "cli-error" } };
      const res = await ici.search({
        workspaceId: args.workspace_id,
        query: args.query,
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.top === undefined ? {} : { top: args.top }),
      }, exec.signal);
      if (!res.ok) return { workspace_id: args.workspace_id, error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        truncated: res.value.truncated,
        ...(res.value.stale === true ? { stale: true } : {}),
        rows: clipEntries([...res.value.rows]).map((r, i) => ({
          rank: i + 1,
          apiId: r.apiId,
          apiName: r.apiName,
          score: r.score,
          ...(r.evidence === "" ? {} : { evidence: r.evidence }),
        })),
      };
    },
  })));
  return disposers;
}
