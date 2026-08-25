import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-defs.ts";

interface ToolExecContext {
  readonly signal: AbortSignal;
  readonly agent?: unknown;
}

interface ToolTextBlock {
  readonly type: "text";
  readonly text: string;
}

type ResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

interface CatalogCountFace {
  listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<ResultLike<{ counts: { total: number } }>>;
}

interface IciBuildResultLike {
  manifest: {
    nodeCount: number;
    edgeCount: number;
    sourceFingerprint: string;
    builtAt: string;
  };
}

interface IciIndexResultLike {
  total: number;
  embedded: number;
  reused: number;
}

interface IciEngineExplainFace {
  explainContext(input: { workspaceId: string; query: string }): Promise<ResultLike<{
    api: { id: string; name: string; path: string };
    technicalText: string;
    downstream: readonly { id: string; kind: string; ref?: string }[];
    impact: ReadonlyArray<{ apiId: string; hops: ReadonlyArray<{ nodeId: string }> }>;
    businessReference: readonly string[];
    manifest: { schemaVersion: number; engineVersion: string; sourceFingerprint: string; stale?: true };
  }>>;
}

interface IciEngineJobsFace {
  build(input: { workspaceId: string }, options?: { signal?: AbortSignal; onProgress?: (c: number, t: number, l: string) => void }): Promise<ResultLike<IciBuildResultLike>>;
  index(input: { workspaceId: string; rebuild?: boolean }, options?: { signal?: AbortSignal; onProgress?: (c: number, t: number, l: string) => void }): Promise<ResultLike<IciIndexResultLike>>;
  diagnostics(input: { workspaceId: string }): Promise<ResultLike<{
    indexPaths: { graphCurrent: string; searchJsonl: string };
    schemaVersion: number;
    engineVersion: string;
    builtAt: string | null;
    nodeCount: number;
    edgeCount: number;
    searchVectors: number;
    stale: boolean;
    requiredFiles: { nodes: boolean; edges: boolean; manifest: boolean };
  }>>;
}

interface JobsRegistryShim {
  start(spec: { kind: string; label: string; owner?: unknown; run(): {
    cancel(reason?: string): void;
    done: Promise<{ status: "completed" | "killed" | "failed"; detail?: string }>;
    readOutput?(): string;
  } }): string;
}

/** Asset count at or below which ici_build runs synchronously. */
export const SYNC_ASSET_THRESHOLD = 50;

function errorText(code: string): string {
  return `icomposer tools error: ${code}`;
}

function objectSchema2(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  const requiredSet = new Set(required);
  return { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, requiredSet.has(key) ? { ...(value as Record<string, unknown>), required: true } : value])) };
}

/**
 * Register the iComposer Code Intelligence background-build and status Agent
 * tools. `ici_build` starts a host job (`ici-build` / `ici-index` kind) for
 * large workspaces and awaits small ones synchronously; `ici_status` is a
 * read-only diagnostics projection.
 * @returns one disposer per registered tool.
 */
export function registerIciJobTools(ctx: Context, defineTool: DefineToolFn): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.systemPrompt.section({
    name: "tool:ici_build",
    order: 150,
    text: "ici_build builds the local iComposer Code Intelligence graph from a registered workspace canonical path; search-index mode uses the Workbench Active Profile for authentication and fails closed when it is unavailable. Small workspaces complete inline; larger ones run as cancellable background jobs.",
  }));
  disposers.push(ctx.systemPrompt.section({
    name: "tool:ici_explain",
    order: 150,
    text: "ici_explain assembles a read-only context bundle (technical text, downstream tree, upstream impact, reference hints) for one api so the current Agent can write its business explanation. Read-only: it never writes files.",
  }));
  disposers.push(ctx.systemPrompt.section({
    name: "tool:ici_status",
    order: 150,
    text: "ici_status reports local iComposer Code Intelligence diagnostics for a registered workspace: snapshot counts, index vectors, staleness, and required-file presence. No InsureMO binding is required."
  }));

  disposers.push(ctx.tools.register(defineTool({
    name: "ici_build",
    description: "Build the local iComposer Code Intelligence graph or authenticated embedding index for a registered workspace. Graph mode needs no binding; search-index mode uses the Workbench Active Profile and fails closed when unavailable.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      mode: { type: "string", enum: ["graph", "search-index"], description: "What to build; default graph." },
      rebuild: { type: "boolean", description: "search-index only: force full re-embedding." },
    },
    output: {
      schema: objectSchema2(
        {
          workspace_id: { type: "string", required: true },
          kind: { type: "string", enum: ["inline", "background"], required: true },
          jobId: { type: "string" },
          label: { type: "string" },
          detail: objectSchema2(
            {
              nodeCount: { type: "integer" },
              edgeCount: { type: "integer" },
              builtAt: { type: "string" },
              total: { type: "integer" },
              embedded: { type: "integer" },
              reused: { type: "integer" },
            },
            [],
          ),
          error: objectSchema2({ code: { type: "string", required: true } }, ["code"]),
        },
        ["workspace_id", "kind"],
      ),
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          kind: "inline" | "background";
          jobId?: string;
          label?: string;
          detail?: { nodeCount?: number; edgeCount?: number; builtAt?: string; total?: number; embedded?: number; reused?: number };
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        if (v.kind === "background") {
          return [{ type: "text", text: `workspace ${v.workspace_id}: background job ${v.jobId} (${v.label}) started` }];
        }
        const d = v.detail ?? {};
        const parts: string[] = [];
        if (d.nodeCount !== undefined) parts.push(`nodes=${d.nodeCount} edges=${d.edgeCount ?? 0}`);
        if (d.total !== undefined) parts.push(`vectors total=${d.total} embedded=${d.embedded ?? 0} reused=${d.reused ?? 0}`);
        return [{ type: "text", text: `workspace ${v.workspace_id}: done — ${parts.join("; ")}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; mode?: "graph" | "search-index"; rebuild?: boolean };
      return runBuild({
        workspace_id: args.workspace_id,
        mode: args.mode ?? "graph",
        ...(args.rebuild === undefined ? {} : { rebuild: args.rebuild }),
      }, exec);
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "ici_status",
    description: "Read-only local iComposer Code Intelligence diagnostics for a registered workspace: snapshot counts, staleness, index vectors, and required files. No InsureMO binding is required.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
    },
    output: {
      schema: objectSchema2(
        {
          workspace_id: { type: "string", required: true },
          builtAt: { type: "string" },
          nodeCount: { type: "integer" },
          edgeCount: { type: "integer" },
          searchVectors: { type: "integer" },
          stale: { type: "boolean" },
          engineVersion: { type: "string" },
          schemaVersion: { type: "integer" },
          requiredFiles: objectSchema2(
            {
              nodes: { type: "boolean" },
              edges: { type: "boolean" },
              manifest: { type: "boolean" },
            },
            ["nodes", "edges", "manifest"],
          ),
          error: objectSchema2({ code: { type: "string", required: true } }, ["code"]),
        },
        ["workspace_id"],
      ),
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          builtAt?: string;
          nodeCount?: number;
          edgeCount?: number;
          searchVectors?: number;
          stale?: boolean;
          requiredFiles?: { nodes: boolean; edges: boolean; manifest: boolean };
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        const rf = v.requiredFiles ?? { nodes: false, edges: false, manifest: false };
        return [{
          type: "text",
          text: [
            `workspace ${v.workspace_id}: nodes=${v.nodeCount ?? 0} edges=${v.edgeCount ?? 0} vectors=${v.searchVectors ?? 0} stale=${v.stale ?? false}`,
            `builtAt=${v.builtAt ?? "never"} files(nodes/edges/manifest)=${rf.nodes}/${rf.edges}/${rf.manifest}`,
          ].join("\n"),
        }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>) {
      const args = rawArgs as { workspace_id: string };
      const ici = ctx.get("iciEngine") as unknown as IciEngineJobsFace | undefined;
      if (!ici) return { workspace_id: args.workspace_id, error: { code: "cli-error" } };
      const res = await ici.diagnostics({ workspaceId: args.workspace_id });
      if (!res.ok) return { workspace_id: args.workspace_id, error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        builtAt: res.value.builtAt ?? "never",
        nodeCount: res.value.nodeCount,
        edgeCount: res.value.edgeCount,
        searchVectors: res.value.searchVectors,
        stale: res.value.stale,
        engineVersion: res.value.engineVersion,
        schemaVersion: res.value.schemaVersion,
        requiredFiles: { ...res.value.requiredFiles },
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "ici_explain",
    description: "Build a bounded local context bundle for one API of a registered workspace: technical text, downstream tree, upstream impact, and reference-doc hints. No InsureMO binding is required.",
    parameters: {
      workspace_id: { type: "string", required: true, description: "Registered workspace id; no InsureMO binding required." },
      query: { type: "string", required: true, description: "Api name or id substring." },
    },
    output: {
      schema: objectSchema2(
        {
          workspace_id: { type: "string", required: true },
          api: objectSchema2(
            {
              id: { type: "string", required: true },
              name: { type: "string", required: true },
              path: { type: "string" },
            },
            ["id", "name"],
          ),
          technicalText: { type: "string" },
          downstreamCount: { type: "integer" },
          impactCount: { type: "integer" },
          businessReference: { type: "array", items: { type: "string" } },
          stale: { type: "boolean" },
          error: objectSchema2({ code: { type: "string", required: true } }, ["code"]),
        },
        ["workspace_id", "api"],
      ),
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          workspace_id: string;
          api: { name: string };
          technicalText?: string;
          downstreamCount?: number;
          impactCount?: number;
          businessReference?: readonly string[];
          error?: { code: string };
        };
        if (v.error !== undefined) return [{ type: "text", text: typeof (v.error as unknown as { guidance?: string }).guidance === "string" ? (v.error as unknown as { guidance: string }).guidance : errorText(v.error.code) }];
        return [{
          type: "text",
          text: [
            `workspace ${v.workspace_id}: api=${v.api.name} downstream=${v.downstreamCount ?? 0} impact=${v.impactCount ?? 0}`,
            `reference=${v.businessReference?.join(", ") || "none"}`,
          ].join("\n"),
        }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecContext) {
      const args = rawArgs as { workspace_id: string; query: string };
      const ici = ctx.get("iciEngine") as unknown as IciEngineExplainFace | undefined;
      if (!ici) return { workspace_id: args.workspace_id, error: { code: "cli-error" } };
      const res = await ici.explainContext({ workspaceId: args.workspace_id, query: args.query });
      if (!res.ok) return { workspace_id: args.workspace_id, error: { code: res.error.code } };
      return {
        workspace_id: args.workspace_id,
        api: { ...res.value.api },
        technicalText: res.value.technicalText,
        downstreamCount: res.value.downstream.length,
        impactCount: res.value.impact.length,
        businessReference: [...res.value.businessReference],
        ...(res.value.manifest.stale === true ? { stale: true } : {}),
      };
    },
  })));

  // Shared execute body for the two job-backed modes.
  async function runBuild(args: {
    workspace_id: string;
    mode: "graph" | "search-index";
    rebuild?: boolean;
  }, exec: ToolExecContext): Promise<Record<string, unknown>> {
    const ici = ctx.get("iciEngine") as unknown as IciEngineJobsFace | undefined;
    if (!ici) return { workspace_id: args.workspace_id, kind: "inline", error: { code: "cli-error" } };
    const catalog = ctx.get("icomposerCatalog") as unknown as CatalogCountFace | undefined;
    let assetTotal = 0;
    if (catalog) {
      const res = await catalog.listAssets({ workspaceId: args.workspace_id }, exec.signal);
      if (res.ok) assetTotal = res.value.counts.total;
    }

    const summarizeGraph = (value: IciBuildResultLike) => ({
      nodeCount: value.manifest.nodeCount,
      edgeCount: value.manifest.edgeCount,
      builtAt: value.manifest.builtAt,
    });
    const summarizeIndex = (value: IciIndexResultLike) => ({
      total: value.total,
      embedded: value.embedded,
      reused: value.reused,
    });

    // Small workspaces finish fast enough to answer inline with full results.
    if (assetTotal <= SYNC_ASSET_THRESHOLD) {
      const signal = exec.signal;
      if (args.mode === "search-index") {
        const res = await ici.index({ workspaceId: args.workspace_id, ...(args.rebuild === undefined ? {} : { rebuild: args.rebuild }) }, { signal });
        if (!res.ok) return { workspace_id: args.workspace_id, kind: "inline", error: { code: res.error.code } };
        return { workspace_id: args.workspace_id, kind: "inline", detail: summarizeIndex(res.value) };
      }
      const res = await ici.build({ workspaceId: args.workspace_id }, { signal });
      if (!res.ok) return { workspace_id: args.workspace_id, kind: "inline", error: { code: res.error.code } };
      return { workspace_id: args.workspace_id, kind: "inline", detail: summarizeGraph(res.value) };
    }

    // Large workspaces run as cancellable host jobs owned by the caller.
    const jobs = ctx.jobs;
    if (!jobs) return { workspace_id: args.workspace_id, kind: "background", error: { code: "cli-error" } };
    const kind = args.mode === "search-index" ? "ici-index" : "ici-build";
    const label = `${kind} ${args.workspace_id}${args.rebuild === true ? " --rebuild" : ""}`;
    const jobId = jobs.start({
      kind,
      label,
      ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
      run: () => {
        const controller = new AbortController();
        const onCallerAbort = (): void => controller.abort();
        exec.signal.addEventListener("abort", onCallerAbort, { once: true });
        const lines: string[] = [];
        const onProgress = (current: number, total: number, step: string): void => {
          lines.push(`[${current}/${total}] ${step}`);
        };
        const work: Promise<ResultLike<IciBuildResultLike | IciIndexResultLike>> = args.mode === "search-index"
          ? ici.index({ workspaceId: args.workspace_id, ...(args.rebuild === undefined ? {} : { rebuild: args.rebuild }) }, { signal: controller.signal, onProgress })
          : ici.build({ workspaceId: args.workspace_id }, { signal: controller.signal, onProgress });
        const done = work.then((res): { status: "completed" | "killed" | "failed"; detail?: string } => {
          exec.signal.removeEventListener("abort", onCallerAbort);
          if (!res.ok) {
            // A cancelled build is a user-initiated kill, not a failure.
            if (res.error.code === "cancelled") return { status: "killed", detail: "cancelled" };
            return { status: "failed", detail: res.error.code };
          }
          if ("manifest" in res.value) {
            return { status: "completed", detail: `nodes=${res.value.manifest.nodeCount} edges=${res.value.manifest.edgeCount}` };
          }
          return { status: "completed", detail: `total=${res.value.total} embedded=${res.value.embedded} reused=${res.value.reused}` };
        }).catch((cause: unknown): { status: "failed"; detail: string } => ({ status: "failed", detail: String(cause) }));
        return {
          cancel: (reason?: string) => {
            controller.abort();
            lines.push(`cancel requested${reason === undefined ? "" : `: ${reason}`}`);
          },
          done,
          readOutput: () => lines.splice(0).join("\n"),
        };
      },
    });
    return { workspace_id: args.workspace_id, kind: "background", jobId, label };
  }

  // ici_build execute wiring (replaces the placeholder above).
  void runBuild;

  return disposers;
}
