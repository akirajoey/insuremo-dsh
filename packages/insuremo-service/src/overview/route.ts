import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OVERVIEW_PATH, type ImoOverview } from "./service.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 256 * 1024;

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
      // (profile-store read + cached projections, no subprocess); `?full=1`
      // or no parameter builds the complete CLI-backed view.
      const url = new URL(req.url ?? "/", "http://localhost");
      const fast = url.searchParams.get("fast") === "1";
      const respond = async (): Promise<void> => {
        try {
          const view = overview === undefined ? undefined
            : fast ? await overview.snapshotFast(controller.signal)
            : await overview.snapshot(controller.signal);
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
