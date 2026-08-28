import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clientBundle } from "../../../deepseek-harness/packages/client/tsdown.client.ts";

const base = clientBundle("@icomposer/ui-insuremo-status", ["src/index.ts"]);
const cleanBrandAssets = {
  name: "ui-insuremo-status: clean emitted brand assets",
  async buildStart(): Promise<void> {
    const assetDir = resolve("lib/assets");
    const files = await readdir(assetDir).catch(() => [] as string[]);
    await Promise.all(files.filter(file => file.endsWith(".png")).map(file => rm(resolve(assetDir, file), { force: true })));
  },
};
const sanitizeCssRegion = {
  name: "ui-insuremo-status: sanitize CSS source regions",
  async writeBundle(options: { dir?: string }, bundle: Record<string, { type: string }>): Promise<void> {
    // The shared preset's virtual CSS id is absolute on disk. Rewrite only the
    // generated region comments after output, preserving source-map offsets and
    // keeping developer machine paths out of the archived client.js.
    await Promise.all(Object.entries(bundle).filter(([, item]) => item.type === "chunk").map(async ([fileName]) => {
      const file = resolve(options.dir ?? ".", fileName);
      const code = await readFile(file, "utf8");
      const clean = code.replace(/\\0dsh-css:\/[^\r\n]*/g, "\\0dsh-css:asset");
      if (clean !== code) await writeFile(file, clean, "utf8");
    }));
  },
};

/**
 * Keep the shared client preset untouched while making normal PNG imports
 * emitted browser assets (never data URIs). The bundle then references files
 * beside lib/client.js, which the package archive includes.
 */
export default (inlineConfig: Parameters<typeof base>[0]) => base(inlineConfig).map(config => ({
  ...config,
  loader: { ...config.loader, ".png": "asset" },
  plugins: [...(config.plugins ?? []), cleanBrandAssets, sanitizeCssRegion],
  outputOptions: {
    ...config.outputOptions,
    assetFileNames: "assets/[name][extname]",
  },
}));
