import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OVERVIEW_PATH } from "./paths.ts";
import { readValidatedExplainFinal } from "@icomposer/workbench-contracts/ici-explain";

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
  diagnostics(input: { readonly workspaceId: string }): Promise<{ ok: boolean; value?: { requiredFiles?: { manifest?: boolean }; stale?: boolean } }>;
}

/**
 * Bounded local read of the workspace-owned schema-3 final explain state.
 * Legacy/context/prepare markers are intentionally never readiness signals. Kept local because this package's tsconfig
 * rootDir cannot include sibling sources.
 */
async function localReadExplainState(canonicalPath: string, workspaceId: string): Promise<boolean> {
  void workspaceId;
  return (await readValidatedExplainFinal(canonicalPath, undefined, workspaceId)) !== null;
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
        graphReady = diag.ok === true && diag.value?.requiredFiles?.manifest === true && diag.value?.stale !== true;
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
