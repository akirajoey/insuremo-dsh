import { harnessSourceAliases } from "../../scripts/harness-test-aliases.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = resolve(packageRoot, "../../../deepseek-harness");
// The H2 checkout has no hoisted root React link; its ui-primitives package
// carries the 18.3.1 pair. Pin the plugin sources, the H2 source packages and
// the renderer's testing-library to that one pair so no second dispatcher loads.
const harnessReact = resolve(harnessRoot, "packages/client/ui-primitives/node_modules/react");
const harnessReactDom = resolve(harnessRoot, "packages/client/ui-primitives/node_modules/react-dom");
const harnessTestingReact = resolve(harnessRoot, "node_modules/@testing-library/react");
const harnessTestingDom = resolve(harnessRoot, "node_modules/@testing-library/dom");

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(harnessRoot, "tsconfig.base.json")] })],
  resolve: {
    alias: [
      ...harnessSourceAliases(harnessRoot),
      { find: /^@testing-library\/react$/, replacement: harnessTestingReact },
      { find: /^@testing-library\/dom$/, replacement: harnessTestingDom },
      { find: /^react-dom$/, replacement: harnessReactDom },
      { find: /^react-dom\/(.*)$/, replacement: `${harnessReactDom}/$1` },
      { find: /^react$/, replacement: harnessReact },
      { find: /^react\/(.*)$/, replacement: `${harnessReact}/$1` },
      {
        find: "@deepseek-ai/dsh-client-locale/client",
        replacement: resolve(harnessRoot, "packages/client/locale/src/client/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-renderer/client",
        replacement: resolve(harnessRoot, "packages/client/ui-renderer/src/client/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-test-runtime",
        replacement: resolve(harnessRoot, "packages/test-support/client-runtime/src/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-sidebar/client",
        replacement: resolve(harnessRoot, "packages/client/ui-sidebar/src/client/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-primitives",
        replacement: resolve(harnessRoot, "packages/client/ui-primitives/src/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-slots",
        replacement: resolve(harnessRoot, "packages/client/ui-slots/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: [resolve(packageRoot, "../../test/setup-browser.ts")],
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["test/**/*.test.tsx"],
  },
});
