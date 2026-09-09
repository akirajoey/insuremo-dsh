import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OVERVIEW_PATH, type ImoOverview } from "./service.ts";
import { parseWorkspaceId, resolveWorkspace } from "../auth/workspace.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 256 * 1024;

/** Resolve the optional workspace selector from an untrusted HTTP query. */
function requestedWorkspace(ctx: Context, value: string | null): { ok: true; workspaceId?: string } | { ok: false; status: 400 | 404 | 503; code: string; message: string } {
  if (value === null) return { ok: true };
  const workspaceId = parseWorkspaceId(value);
  if (workspaceId === undefined) return { ok: false, status: 400, code: "invalid-workspace-id", message: "workspace id is invalid" };
  const resolved = resolveWorkspace(ctx, workspaceId);
  if (resolved.ok) return { ok: true, workspaceId: resolved.workspaceId };
  const status = resolved.code === "workspace-not-found" ? 404 : resolved.code === "workspace-unavailable" ? 503 : 400;
  return { ok: false, status, code: resolved.code, message: resolved.message };
}

/**
 * Mount the read-only GET overview route on the web server. This is a
 * same-origin read bridge only: no POST/approve/execute transport exists yet
 * (the write transport's CSRF/Origin design is a documented Phase 2 risk).
 */
export function mountOverviewRoute(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: "exact",
    path: OVERVIEW_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, {
          Allow: "GET",
          "Content-Type": JSON_TYPE,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
      }
      const controller = new AbortController();
      const onClose = (): void => controller.abort();
      res.on("close", onClose);
      const overview = ctx.get<ImoOverview>("imoOverview");
      // Fast/full channel split (TASK-041): `?fast=1` answers in milliseconds
      // (cached sanitized projections, no subprocess on a warm read). A
      // workspace selector is an id only; the server resolves its canonical
      // cwd through the trusted registry before any auth call.
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = requestedWorkspace(ctx, url.searchParams.get("workspaceId"));
      if (!target.ok) {
        res.writeHead(target.status, {
          "Content-Type": JSON_TYPE,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: { code: target.code, message: target.message } }));
        res.off("close", onClose);
        return;
      }
      const fast = url.searchParams.get("fast") === "1";
      const respond = async (): Promise<void> => {
        try {
          const view = overview === undefined ? undefined
            : fast
              ? target.workspaceId === undefined ? await overview.snapshotFast(controller.signal) : await overview.snapshotFast(controller.signal, target.workspaceId)
              : target.workspaceId === undefined ? await overview.snapshot(controller.signal) : await overview.snapshot(controller.signal, target.workspaceId);
          if (res.destroyed || res.writableEnded) return;
          const body = view === undefined ? "{}" : JSON.stringify(view);
          const bounded = body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;
          res.writeHead(200, {
            "Content-Type": JSON_TYPE,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(req.method === "HEAD" ? undefined : bounded);
        } catch {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(500, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            res.end();
          }
        } finally {
          res.off("close", onClose);
        }
      };
      void respond();
    },
  });
}
