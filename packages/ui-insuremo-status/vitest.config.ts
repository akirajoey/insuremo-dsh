import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = resolve(packageRoot, "../../../deepseek-harness");
const harnessReact = resolve(harnessRoot, "packages/client/ui-primitives/node_modules/react");
const harnessReactDom = resolve(harnessRoot, "packages/client/ui-primitives/node_modules/react-dom");

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(harnessRoot, "tsconfig.base.json")] })],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // Harness source packages are symlinked outside this workspace and carry
      // React 18.3; pin the test graph to that same React/DOM pair so Tooltip
      // hooks and the slot renderer do not load two React dispatchers.
      { find: "react-dom/client", replacement: resolve(harnessReactDom, "client") },
      { find: "react-dom", replacement: harnessReactDom },
      { find: "react", replacement: harnessReact },
      {
        find: "@deepseek-ai/dsh-client-locale/client",
        replacement: resolve(harnessRoot, "packages/client/locale/src/client/index.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-runtime/client",
        replacement: resolve(harnessRoot, "packages/client/runtime/src/client/index.ts"),
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
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["test/**/*.test.tsx"],
  },
});
