#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = resolve(root, "../deepseek-harness");
const expected = JSON.parse(readFileSync(resolve(root, "compatibility.json"), "utf8"));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
// Never reuse another checkout's installed libraries. This setup is for isolated worktrees only.
if (!root.includes("/upgrade-dsh-0.2.1/")) throw new Error("Run in the upgrade-dsh-0.2.1 isolated worktrees, not the original repositories");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: harness, encoding: "utf8" }).trim();
if (head !== expected.harnessCommit) throw new Error("Harness commit mismatch");
const prefix = resolve(harness, ".migration-tools");
const modules = resolve(harness, "node_modules");
if (existsSync(modules) && !realpathSync(modules).startsWith(`${harness}/`)) throw new Error("Refusing node_modules linked outside the isolated harness");
const deps = { "@deepseek-ai/dsh": "0.2.1-rc.2", tsdown: "0.22.2", lightningcss: "^1.32.0", tsx: "^4.22.4", typescript: "^6.0.3", vitest: "^4.1.8", "@playwright/test": "^1.64.1", "@testing-library/react": "^16.3.3", "@testing-library/dom": "^10.4.1" };
for (const name of ["ui-primitives", "store", "ui-renderer", "ui-conversation", "ui-dockkit", "ui-chat"]) {
  const pkg = JSON.parse(readFileSync(resolve(harness, "packages/client", name, "package.json"), "utf8"));
  for (const [key, value] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!key.startsWith("@deepseek-ai/") && !key.startsWith("@types/")) deps[key] = value;
  }
}
mkdirSync(prefix, { recursive: true });
run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--save-exact", ...Object.entries(deps).map(([key, value]) => `${key}@${value}`)]);
if (!existsSync(modules)) symlinkSync(".migration-tools/node_modules", modules, "dir");
run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
console.log("Isolated dependencies ready. No service started. See docs/dsh-0.2.1-migration.md.");
