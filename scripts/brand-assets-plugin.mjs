import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/** Preserve owned PNG files alongside client.js; the host serves these by name. */
export function brandAssetsPlugin() {
  return {
    name: "icomposer: brand assets",
    async load(id) {
      if (!id.endsWith(".png")) return;
      const fileName = `assets/${basename(id)}`;
      this.addWatchFile(id);
      this.emitFile({ type: "asset", fileName, source: await readFile(id) });
      return `export default ${JSON.stringify(`./${fileName}`)};`;
    },
  };
}
