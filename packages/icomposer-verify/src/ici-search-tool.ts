import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-types.ts";

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
    /** TASK-132: the engine used the offline local ranking (no embedding index / no Active Profile). */
    degraded?: true;
    degradedReason?: string;
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
  const requiredSet = new Set(required);
  return { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, requiredSet.has(key) ? { ...(value as Record<string, unknown>), required: true } : value])) };
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
    description: "Find APIs by what they DO, in natural language -- capability discovery over the workspace API explanations (iComposer Code Intelligence). Use this FIRST for questions like 'which APIs can modify the group policy member', 'is there an API that cancels a rider', or 'what handles claim rejection', instead of grepping the source tree. Returns ranked APIs (apiId/apiName/score/evidence); follow up with ici_query (query=api-chain) for the call chain of a hit. Local term-frequency ranking is used and the result is marked degraded when the embedding index or the Workbench Active Profile is unavailable.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
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
          degraded: { type: "boolean" },
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
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        const lines = [
          `workspace ${v.workspace_id}: ${v.rows?.length ?? 0} results${(v as { degraded?: boolean }).degraded === true ? " (degraded: local ranking, no embedding index/profile)" : ""}`,
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
        ...(res.value.degraded === true ? { degraded: true } : {}),
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
