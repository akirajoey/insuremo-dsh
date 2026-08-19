import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = resolve(packageRoot, "../../../deepseek-harness");

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(harnessRoot, "tsconfig.base.json")] })],
  resolve: {
    alias: [
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
