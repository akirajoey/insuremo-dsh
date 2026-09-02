import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeCssSourceRegions } from "../../scripts/dist-payload.mjs";
import { clientBundle } from "../../../deepseek-harness/packages/client/tsdown.client.ts";

/**
 * Distributable bundle: lib/index.js (host aggregate, @deepseek-ai/* and
 * react external as peers; @icomposer/* + zod inlined) and lib/client.js
 * (closure-factory client aggregate for the three UI blocks).
 */
const base = clientBundle("@icomposer/workbench", ["src/index.ts"], {
  hostPhase: true,
});
const sanitizeCssRegion = {
  name: "@icomposer/workbench: sanitize CSS source regions",
  async writeBundle(options: { dir?: string }, bundle: Record<string, { type: string }>): Promise<void> {
    await Promise.all(Object.entries(bundle).filter(([, item]) => item.type === "chunk").map(async ([fileName]) => {
      const file = resolve(options.dir ?? ".", fileName);
      const code = await readFile(file, "utf8");
      const clean = canonicalizeCssSourceRegions(Buffer.from(code, "utf8")).toString("utf8");
      if (clean !== code) await writeFile(file, clean, "utf8");
    }));
  },
};

/** Keep normal PNG imports as archive-served files in the aggregate too. */
export default (inlineConfig: Parameters<typeof base>[0]) => base(inlineConfig).map(config => ({
  ...config,
  loader: { ...config.loader, ".png": "asset" },
  plugins: [...(config.plugins ?? []), sanitizeCssRegion],
  outputOptions: {
    ...config.outputOptions,
    assetFileNames: "assets/[name][extname]",
  },
}));
