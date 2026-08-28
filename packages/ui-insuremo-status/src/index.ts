import type { IncomingMessage, ServerResponse } from "node:http";
import { BRAND_ASSET_ROUTE, serveBrandAsset } from "./brand-assets-server.ts";

/** Host-facing subset needed to serve the client bundle's emitted PNG assets. */
interface AssetHostContext {
  readonly webServer: {
    register(route: {
      readonly kind: "prefix";
      readonly path: string;
      readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
  };
  effect(setup: () => void | (() => void | Promise<void>), label?: string): unknown;
}

/** Host bundle and client bundle each resolve their own lib/assets directory. */
const ASSET_ROOT = new URL("./assets/", import.meta.url);

/** Host-only plugin entry: serve the three independent raster assets. */
export const inject = ["webServer"] as const;
export function apply(ctx: AssetHostContext): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: BRAND_ASSET_ROUTE,
      handler: (req, res) => serveBrandAsset(req, res, ASSET_ROOT),
    }),
    "ui-insuremo-status: emitted brand assets",
  );
}
