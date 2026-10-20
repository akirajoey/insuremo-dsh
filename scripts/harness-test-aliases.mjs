import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The source test runtime uses /src imports, not npm export subpaths. */
export function harnessSourceAliases(harnessRoot) {
  return readdirSync(resolve(harnessRoot, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(group => readdirSync(resolve(harnessRoot, "packages", group.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const dir = resolve(harnessRoot, "packages", group.name, entry.name);
        try {
          const { name } = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
          return [{ find: `${name}/src`, replacement: resolve(dir, "src") },
            { find: new RegExp(`^${name}$`), replacement: resolve(dir, "src/index.ts") }];
        } catch { return []; }
      }));
}
