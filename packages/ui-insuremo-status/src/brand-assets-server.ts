import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Stable public namespace shared by standalone and aggregate Workbench bundles. */
export const BRAND_ASSET_ROUTE = "/api/icomposer-workbench/ui/assets" as const;

/** Only these owned files are ever exposed; the route never lists a directory. */
export const BRAND_ASSET_NAMES = [
  "insuremo-wordmark-light.png",
  "insuremo-wordmark-dark.png",
  "insuremo-globe.png",
] as const;
type BrandAssetName = (typeof BRAND_ASSET_NAMES)[number];

function isBrandAssetName(value: string): value is BrandAssetName {
  return (BRAND_ASSET_NAMES as readonly string[]).includes(value);
}

/** Serve one emitted PNG from a package-relative asset root with no path input. */
export async function serveBrandAsset(
  req: IncomingMessage,
  res: ServerResponse,
  assetRoot: URL,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  // Compare the raw origin-form pathname directly. URL.pathname would
  // normalize `/assets/../assets/foo.png` before validation; exact ASCII
  // matching rejects raw/encoded dot segments, separators, NUL, and malformed
  // percent escapes without ever decoding or joining attacker input.
  const rawPath = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  const prefix = `${BRAND_ASSET_ROUTE}/`;
  const filename = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : "";
  if (!isBrandAssetName(filename)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(new URL(filename, assetRoot));
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(body.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
