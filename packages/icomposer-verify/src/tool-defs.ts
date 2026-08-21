import type { Context } from "@deepseek-ai/cordis";

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

const TOOL_ENTRY_LIMIT = 50;

function clipEntries<T>(items: readonly T[]): T[] {
  return items.slice(0, TOOL_ENTRY_LIMIT);
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

  disposers.push(ctx.tools.register(defineTool({
    name: "icomposer_catalog_list",
    description: "List the read-only iComposer asset catalog (api/function/batch/model) of a bound workspace with join status. Effect: none.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Bound workspace id." },
      type: { type: "string", enum: ["api", "function", "batch", "model"], description: "Optional asset type filter." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_id: { type: "string", required: true },
          counts: {
            type: "object",
            additionalProperties: false,
            properties: {
              api: { type: "integer" },
              function: { type: "integer" },
              batch: { type: "integer" },
              model: { type: "integer" },
              total: { type: "integer" },
            },
          },
          truncated: { type: "boolean" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                type: { type: "string", required: true },
                joinStatus: { type: "string", required: true },
              },
            },
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
          counts?: { api: number; function: number; batch: number; model: number; total: number };
          truncated?: boolean;
          entries?: readonly { name: string; type: string; joinStatus: string }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: errorText(v.error.code) }];
        const c = v.counts!;
        const lines = [
          `workspace ${v.workspace_id}: ${c.total} assets (api ${c.api}, function ${c.function}, batch ${c.batch}, model ${c.model}) truncated=${v.truncated ?? false}`,
          ...clipEntries(v.entries ?? []).map(e => `${e.type}\t${e.name}\t${e.joinStatus}`),
        ];
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; type?: string };
      const catalog = ctx.get("icomposerCatalog") as unknown as CatalogFace | undefined;
      if (!catalog) return { workspace_id: args.workspace_id, error: { code: "cli-error" } };
      const res = await catalog.listAssets({ workspaceId: args.workspace_id, ...(args.type === undefined ? {} : { type: args.type }) }, exec.signal);
      if (!res.ok) return { workspace_id: args.workspace_id, error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        counts: { ...res.value.counts },
        truncated: res.value.truncated,
        entries: clipEntries([...res.value.entries.map(e => ({ name: e.name, type: e.type, joinStatus: e.joinStatus }))]),
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "icomposer_sdk_query",
    description: "Query SDK client operations of a bound workspace by client name and/or keyword. Effect: none.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Bound workspace id." },
      client: { type: "string", description: "Exact SDK client name filter." },
      keyword: { type: "string", description: "Case-insensitive keyword over client/path/operationId/summary/tag." },
      limit: { type: "number", description: "Maximum operations to scan (service cap 200)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_id: { type: "string", required: true },
          count: { type: "integer" },
          total: { type: "integer" },
          truncated: { type: "boolean" },
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                client: { type: "string", required: true },
                method: { type: "string", required: true },
                path: { type: "string", required: true },
                operationId: { type: "string", required: true },
              },
            },
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
          count?: number;
          total?: number;
          truncated?: boolean;
          operations?: readonly { client: string; method: string; path: string; operationId: string }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: errorText(v.error.code) }];
        const lines = [
          `workspace ${v.workspace_id}: ${v.count ?? 0} operations shown of ${v.total ?? 0} truncated=${v.truncated ?? false}`,
          ...clipEntries(v.operations ?? []).map(o => `${o.method.toUpperCase()}\t${o.client}\t${o.operationId}\t${o.path}`),
        ];
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; client?: string; keyword?: string; limit?: number };
      const reference = ctx.get("icomposerReference") as unknown as ReferenceFace | undefined;
      if (!reference) return { workspace_id: args.workspace_id, error: { code: "cli-error" } };
      const res = await reference.querySdkOperations({
        workspaceId: args.workspace_id,
        ...(args.client === undefined ? {} : { client: args.client }),
        ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }, exec.signal);
      if (!res.ok) return { workspace_id: args.workspace_id, error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        count: res.value.operations.length,
        total: res.value.counts.operations,
        truncated: res.value.truncated,
        operations: clipEntries([...res.value.operations.map(o => ({ client: o.client, method: o.method, path: o.path, operationId: o.operationId }))]),
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "icomposer_verify_utils",
    description: "List known iComposer utility classes or search their methods in a bound workspace. Effect: none.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Bound workspace id." },
      keyword: { type: "string", description: "Search keyword; omitted lists all utility classes." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_id: { type: "string", required: true },
          mode: { type: "string", enum: ["list", "search"], required: true },
          count: { type: "integer" },
          truncated: { type: "boolean" },
          classes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                className: { type: "string", required: true },
                methodCount: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
          matches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                className: { type: "string", required: true },
                method: { type: "string" },
                description: { type: "string" },
              },
            },
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
          mode: "list" | "search";
          count?: number;
          truncated?: boolean;
          classes?: readonly { className: string; methodCount: number; description?: string }[];
          matches?: readonly { className: string; method?: string; description?: string }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: errorText(v.error.code) }];
        const header = `workspace ${v.workspace_id}: ${v.mode} ${v.count ?? 0} results truncated=${v.truncated ?? false}`;
        const body = v.mode === "list"
          ? clipEntries(v.classes ?? []).map(c => `${c.className}\t${c.methodCount}`)
          : clipEntries(v.matches ?? []).map(m => `${m.className}.${m.method ?? "*"}\t${m.description ?? ""}`);
        return [{ type: "text", text: [header, ...body].join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; keyword?: string };
      const verify = ctx.get("icomposerVerify") as unknown as VerifyFace | undefined;
      if (!verify) return { workspace_id: args.workspace_id, mode: "list", error: { code: "cli-error" } };
      if (args.keyword === undefined) {
        const res = await verify.listUtils({ workspaceId: args.workspace_id }, exec.signal);
        if (!res.ok) return { workspace_id: args.workspace_id, mode: "list", error: { code: res.error.code } };
        return {
          workspace_id: args.workspace_id,
          mode: "list",
          count: res.value.count,
          truncated: res.value.truncated,
          classes: clipEntries([...res.value.classes.map(c => ({
            className: c.className,
            methodCount: c.methodCount,
            ...(c.description === undefined ? {} : { description: c.description }),
          }))]),
        };
      }
      const res = await verify.searchUtils({ workspaceId: args.workspace_id, keyword: args.keyword }, exec.signal);
      if (!res.ok) return { workspace_id: args.workspace_id, mode: "search", error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        mode: "search",
        count: res.value.count,
        truncated: res.value.truncated,
        matches: clipEntries([...res.value.matches.map(m => ({
          className: m.className,
          ...(m.method === undefined ? {} : { method: m.method }),
          ...(m.description === undefined ? {} : { description: m.description }),
        }))]),
      };
    },
  })));
  return disposers;
}
