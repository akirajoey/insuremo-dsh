import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OVERVIEW_PATH } from "./paths.ts";

const JSON_TYPE = "application/json; charset=utf-8";

/** Default InsureMO embedding endpoint (mirrors the ici package constant). */
export const DEFAULT_EMBEDDING_ENDPOINT = "https://portal-gw.insuremo.com/mo-re/1.0/aiqa/api/embedding";

/** GET route: per-workspace iComposer/ICI health (icon data source). */
export const WORKSPACES_STATUS_PATH = `${OVERVIEW_PATH}/workspaces/status` as const;

export interface WorkspaceStatusEntry {
  readonly workspaceId: string;
  /** Workspace display title (registry title; falls back to the id). */
  readonly displayName: string;
  /** iComposer project detected (strong signatures). */
  readonly detected: boolean;
  /** bound | pending (detected, unbound) | none. */
  readonly autoBindState: "bound" | "pending" | "none";
  /** ICI graph snapshot exists (graph/current/manifest). */
  readonly graphReady: boolean;
  /** explainState marker exists (explain produced at least once). */
  readonly explainReady: boolean;
}

interface WorkspaceBindingListEntryLike {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly displayName?: string;
  readonly detectedIcomposer?: boolean;
  readonly autoBindState?: "bound" | "pending" | "none";
}

interface IciDiagnosticsFace {
  diagnostics(input: { readonly workspaceId: string }): Promise<{ ok: boolean; value?: { requiredFiles?: { manifest?: boolean } } }>;
}

/**
 * Bounded local read of the workspace-owned explain artifact state, with a
 * legacy DSH_HOME marker fallback. Kept local because this package's tsconfig
 * rootDir cannot include sibling sources.
 */
async function localReadExplainState(canonicalPath: string, workspaceId: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { realpathSync } = await import("node:fs");
  const statePath = join(canonicalPath, ".metadata", "icomposer", "ici", "explain", "state.json");
  let stateText: string;
  try { stateText = await readFile(statePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    stateText = "";
  }
  if (stateText.length > 0) {
    try {
      const state = JSON.parse(stateText) as { schemaVersion?: unknown; artifactPath?: unknown; kind?: unknown; generatedAt?: unknown; apiName?: unknown };
      if (state.schemaVersion !== 2 || (state.kind !== "context" && state.kind !== "deterministic") || typeof state.generatedAt !== "string" || state.generatedAt.length === 0 || typeof state.apiName !== "string" || state.apiName.length === 0 || typeof state.artifactPath !== "string" || !state.artifactPath.startsWith(".metadata/icomposer/ici/explain/") || state.artifactPath.includes("..")) return false;
      const base = state.apiName.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "api";
      const suffix = createHash("sha256").update(state.apiName).digest("hex").slice(0, 12);
      const expected = `.metadata/icomposer/ici/explain/${base}-${suffix}/${state.kind === "context" ? "context" : "deterministic"}.json`;
      if (state.artifactPath !== expected) return false;
      const artifact = JSON.parse(await readFile(join(canonicalPath, state.artifactPath), "utf8")) as { schemaVersion?: unknown; kind?: unknown; bundle?: Record<string, unknown>; result?: Record<string, unknown> };
      if (artifact.schemaVersion !== 2 || artifact.kind !== state.kind) return false;
      if (state.kind === "context") {
        const bundle = artifact.bundle;
        return bundle !== undefined && typeof bundle.api === "object" && typeof bundle.manifest === "object" && typeof bundle.technicalText === "string" && Array.isArray(bundle.downstream) && Array.isArray(bundle.impact);
      }
      const result = artifact.result;
      return result !== undefined && typeof result.technical === "string" && typeof result.business === "string" && Array.isArray(result.method);
    } catch { return false; }
  }
  try {
    let real = canonicalPath;
    try { real = realpathSync(canonicalPath); } catch { /* keep */ }
    const hash = createHash("sha256").update(`${real}:${workspaceId}`).digest("hex").slice(0, 16);
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const parsed = JSON.parse(await readFile(join(dshHome, "ici", hash, "explain-state.json"), "utf8")) as { schemaVersion?: unknown };
    return parsed.schemaVersion === 1;
  } catch { return false; }
}

/**
 * Build the per-workspace status projection: binding face rows joined with
 * the ICI manifest presence (graphReady) and the explain-state marker
 * (explainReady). Read-only; every miss degrades to false, never errors.
 */
export async function buildWorkspaceStatuses(ctx: Context): Promise<readonly WorkspaceStatusEntry[]> {
  const binding = ctx.get("workspaceBinding" as never) as unknown as {
    list(signal?: AbortSignal): Promise<{ ok: boolean; value?: readonly WorkspaceBindingListEntryLike[] }>;
  } | undefined;
  if (binding === undefined) return [];
  let rows: readonly WorkspaceBindingListEntryLike[] = [];
  try {
    const res = await binding.list();
    if (res.ok === true && Array.isArray(res.value)) rows = res.value;
  } catch {
    return [];
  }
  const ici = ctx.get("iciEngine" as never) as unknown as IciDiagnosticsFace | undefined;
  const readExplainState = localReadExplainState;
  const entries: WorkspaceStatusEntry[] = [];
  for (const row of rows.slice(0, 100)) {
    let graphReady = false;
    let explainReady = false;
    if (ici !== undefined) {
      try {
        const diag = await ici.diagnostics({ workspaceId: row.workspaceId });
        graphReady = diag.ok === true && diag.value?.requiredFiles?.manifest === true;
      } catch { /* degrade to false */ }
    }
    try {
      explainReady = await readExplainState(row.canonicalPath, row.workspaceId);
    } catch { /* degrade to false */ }
    entries.push(Object.freeze({
      workspaceId: row.workspaceId,
      displayName: row.displayName && row.displayName.length > 0 ? row.displayName : row.workspaceId,
      detected: row.detectedIcomposer === true,
      autoBindState: row.autoBindState ?? "none",
      graphReady,
      explainReady,
    }));
  }
  return Object.freeze(entries);
}

/**
 * Mount the read-only workspaces status route (GET only, no-store, nosniff).
 * The UI polls it (60s TTL) or fetches on workspace switch.
 */
export function mountWorkspacesStatusRoute(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: "exact",
    path: WORKSPACES_STATUS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET", "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end();
        return;
      }
      const controller = new AbortController();
      const onClose = (): void => controller.abort();
      res.on("close", onClose);
      void (async () => {
        try {
          const statuses = await buildWorkspaceStatuses(ctx);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          res.end(req.method === "HEAD" ? undefined : JSON.stringify({ workspaces: statuses }));
        } catch {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(500, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            res.end();
          }
        } finally {
          res.off("close", onClose);
        }
      })();
    },
  });
}
