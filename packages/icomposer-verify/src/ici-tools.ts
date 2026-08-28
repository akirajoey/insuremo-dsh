import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-types.ts";
import { catalogListOutputSchema, sdkQueryOutputSchema, verifyUtilsOutputSchema } from "./ici-tool-schemas.ts";

interface ToolExecContext {
  readonly signal: AbortSignal;
}

type ResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface IciQueryApiResult {
  matched: readonly string[];
  truncated: boolean;
  truncatedAt?: readonly string[];
  stale?: true;
  roots: readonly unknown[];
}

interface IciQueryImpactResult {
  matched: readonly string[];
  paths: readonly { readonly apiId: string; readonly hops: readonly { readonly nodeId: string }[] }[];
  confidenceCounts: { static: number; platform: number; inferred: number };
  truncated: boolean;
  stale?: true;
}

interface ReferenceFace {
  querySdkOperations(input: { workspaceId: string; client?: string; keyword?: string; limit?: number }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { clients: number; operations: number };
    truncated: boolean;
    operations: readonly { readonly client: string; readonly method: string; readonly path: string; readonly operationId: string }[];
  }>>;
}

interface CatalogFace {
  listAssets(input: { workspaceId: string; type?: string }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { api: number; function: number; batch: number; model: number; total: number };
    truncated: boolean;
    entries: readonly { readonly name: string; readonly type: string; readonly joinStatus: string }[];
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

interface IciEngineFace {
  queryApi(input: { workspaceId: string; query: string; depth?: number; focus?: string; maxNodes?: number }, signal?: AbortSignal): Promise<ResultLike<IciQueryApiResult>>;
  queryImpact(input: { workspaceId: string; query: string }, signal?: AbortSignal): Promise<ResultLike<IciQueryImpactResult>>;
}

interface IciTreeLine {
  readonly depth: number;
  readonly label: string;
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

interface IciQueryApiResult {
  matched: readonly string[];
  truncated: boolean;
  truncatedAt?: readonly string[];
  stale?: true;
  roots: readonly unknown[];
}

interface IciQueryImpactResult {
  matched: readonly string[];
  paths: readonly { readonly apiId: string; readonly hops: readonly { readonly nodeId: string }[] }[];
  confidenceCounts: { static: number; platform: number; inferred: number };
  truncated: boolean;
  stale?: true;
}

interface ReferenceFace {
  querySdkOperations(input: { workspaceId: string; client?: string; keyword?: string; limit?: number }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { clients: number; operations: number };
    truncated: boolean;
    operations: readonly { readonly client: string; readonly method: string; readonly path: string; readonly operationId: string }[];
  }>>;
}

interface CatalogFace {
  listAssets(input: { workspaceId: string; type?: string }, signal?: AbortSignal): Promise<ResultLike<{
    counts: { api: number; function: number; batch: number; model: number; total: number };
    truncated: boolean;
    entries: readonly { readonly name: string; readonly type: string; readonly joinStatus: string }[];
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

interface IciEngineFace {
  queryApi(input: { workspaceId: string; query: string; depth?: number; focus?: string; maxNodes?: number }, signal?: AbortSignal): Promise<ResultLike<IciQueryApiResult>>;
  queryImpact(input: { workspaceId: string; query: string }, signal?: AbortSignal): Promise<ResultLike<IciQueryImpactResult>>;
}

/**
 * Register the read-only iComposer graph-query Agent tool using the host
 * defineTool factory.
 * @returns one disposer for the registered tool.
 */
export function registerIciTools(ctx: Context, defineTool: DefineToolFn): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.systemPrompt.section({
    name: "tool:ici_query",
    order: 150,
    text: "ici_query runs local iComposer Code Intelligence graph queries over a registered workspace canonical path: api-chain walks an API's downstream call tree; impact traces upstream function/method callers to APIs. No InsureMO binding is required and the operation is read-only.",
  }));
  disposers.push(ctx.tools.register(defineTool({
    name: "icomposer_catalog_list",
    description: "List the read-only local iComposer asset catalog (api/function/batch/model) of a registered workspace with join status. No InsureMO binding is required.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      type: { type: "string", enum: ["api", "function", "batch", "model"], description: "Optional asset type filter." },
    },
    output: {
      schema: catalogListOutputSchema(),
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          counts?: { api: number; function: number; batch: number; model: number; total: number };
          truncated?: boolean;
          entries?: readonly { name: string; type: string; joinStatus: string }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
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
    description: "Query local SDK client operations of a registered workspace by client name and/or keyword. No InsureMO binding is required.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      client: { type: "string", description: "Exact SDK client name filter." },
      keyword: { type: "string", description: "Case-insensitive keyword over client/path/operationId/summary/tag." },
      limit: { type: "number", description: "Maximum operations to scan (service cap 200)." },
    },
    output: {
      schema: sdkQueryOutputSchema(),
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          count?: number;
          total?: number;
          truncated?: boolean;
          operations?: readonly { client: string; method: string; path: string; operationId: string }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        const lines = [
          `workspace ${v.workspace_id}: ${v.count ?? 0} operations shown of ${v.total ?? 0} truncated=${v.truncated ?? false}`,
          ...clipEntries(v.operations ?? []).map((o: { method: string; client: string; operationId: string; path: string }) => `${o.method.toUpperCase()}\t${o.client}\t${o.operationId}\t${o.path}`),
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
    description: "List known iComposer utility classes or search their methods in a registered workspace using the Workbench Active Profile for CLI authentication. Fails closed when that profile is unavailable.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      keyword: { type: "string", description: "Search keyword; omitted lists all utility classes." },
    },
    output: {
      schema: verifyUtilsOutputSchema(),
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
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        const header = `workspace ${v.workspace_id}: ${v.mode} ${v.count ?? 0} results truncated=${v.truncated ?? false}`;
        const body = v.mode === "list"
          ? clipEntries(v.classes ?? []).map((c: { className: string; methodCount: number }) => `${c.className}\t${c.methodCount}`)
          : clipEntries(v.matches ?? []).map((m: { className: string; method?: string; description?: string }) => `${m.className}.${m.method ?? "*"}\t${m.description ?? ""}`);
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

  disposers.push(ctx.tools.register(defineTool({
    name: "ici_query",
    description: "Run local iComposer Code Intelligence graph queries on a registered workspace: mode api-chain walks an API's downstream call tree; mode impact traces upstream callers of a function/method to APIs. No InsureMO binding is required.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      mode: { type: "string", enum: ["api-chain", "impact"], required: true, description: "Query direction." },
      query: { type: "string", required: true, description: "Node name or id substring (comma-separated for multiple)." },
      depth: { type: "number", description: "api-chain only: maximum tree depth (default 10, cap 50)." },
      max_nodes: { type: "number", description: "api-chain only: maximum nodes (default 120, cap 2000)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace_id: { type: "string", required: true },
          mode: { type: "string", enum: ["api-chain", "impact"], required: true },
          matched: { type: "array", items: { type: "string" } },
          truncated: { type: "boolean" },
          stale: { type: "boolean" },
          lines: {
            type: "array",
            items: objectSchema2({ depth: { type: "integer", required: true }, label: { type: "string", required: true } }, ["depth", "label"]),
          },
          paths: {
            type: "array",
            items: objectSchema2(
              {
                apiId: { type: "string", required: true },
                hops: { type: "array", items: { type: "string" } },
              },
              ["apiId", "hops"],
            ),
          },
          confidenceCounts: objectSchema2(
            {
              static: { type: "integer" },
              platform: { type: "integer" },
              inferred: { type: "integer" },
            },
            [],
          ),
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
          mode: "api-chain" | "impact";
          truncated?: boolean;
          stale?: boolean;
          lines?: readonly IciTreeLine[];
          paths?: readonly { apiId: string; hops: readonly string[] }[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        const header = `workspace ${v.workspace_id}: ici ${v.mode} truncated=${v.truncated ?? false}${v.stale === true ? " STALE (sources changed since last build)" : ""}`;
        const body = v.mode === "api-chain"
          ? (v.lines ?? []).map(l => `${"  ".repeat(l.depth)}${l.label}`)
          : (v.paths ?? []).map(p => `${p.apiId}\n${p.hops.map(h => `  ${h}`).join("\n")}`);
        return [{ type: "text", text: [header, ...body].join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; mode: "api-chain" | "impact"; query: string; depth?: number; max_nodes?: number };
      const ici = ctx.get("iciEngine") as unknown as IciEngineFace | undefined;
      if (!ici) return { workspace_id: args.workspace_id, mode: args.mode, error: { code: "cli-error" } };
      if (args.mode === "impact") {
        const res = await ici.queryImpact({ workspaceId: args.workspace_id, query: args.query }, exec.signal);
        if (!res.ok) return { workspace_id: args.workspace_id, mode: args.mode, error: { code: res.error.code } };
        return {
          workspace_id: args.workspace_id,
          mode: args.mode,
          matched: [...res.value.matched],
          truncated: res.value.truncated,
          ...(res.value.stale === true ? { stale: true } : {}),
          paths: clipEntries([...res.value.paths]).map(p => ({
            apiId: p.apiId,
            hops: p.hops.map(h => h.nodeId),
          })),
          confidenceCounts: { ...res.value.confidenceCounts },
        };
      }
      const res = await ici.queryApi({
        workspaceId: args.workspace_id,
        query: args.query,
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.max_nodes === undefined ? {} : { max_nodes: args.max_nodes }),
      }, exec.signal);
      if (!res.ok) return { workspace_id: args.workspace_id, mode: args.mode, error: { code: res.error.code } };
      // Flatten the tree into bounded depth/label lines for canonical output.
      const lines: IciTreeLine[] = [];
      const visit = (node: unknown, depth: number): void => {
        if (lines.length >= TOOL_ENTRY_LIMIT * 8) return;
        const n = node as { id: string; kind: string; ref?: string; edge?: { kind: string }; children?: readonly unknown[] };
        const edgeKind = n.edge?.kind ?? "ROOT";
        const ref = n.ref !== undefined ? ` (${n.ref})` : "";
        lines.push({ depth, label: `[${edgeKind}] ${n.id}${ref}` });
        for (const child of n.children ?? []) visit(child, depth + 1);
      };
      for (const root of res.value.roots) visit(root, 0);
      return {
        workspace_id: args.workspace_id,
        mode: args.mode,
        matched: [...res.value.matched],
        truncated: res.value.truncated,
        ...(res.value.stale === true ? { stale: true } : {}),
        lines,
      };
    },
  })));
  return disposers;
}
