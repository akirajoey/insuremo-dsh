#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (!root.includes("/upgrade-dsh-0.2.1/")) throw new Error("Use the isolated upgrade worktree");
const home = resolve(root, ".dsh-home/tests");
const osHome = resolve(home, "os-home");
mkdirSync(osHome, { recursive: true });
const env = { ...process.env, DSH_HOME: home, HOME: osHome, USERPROFILE: osHome, WORKBENCH_REAL_PROJECT_SMOKE: "0" };
const run = (command, args, extra = {}) => {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("pnpm", ["--filter", "@icomposer/ui-insuremo-settings", "--filter", "@icomposer/ui-insuremo-status", "--filter", "@icomposer/ui-workbench-jobs", "run", "test"]);
run("pnpm", ["--filter", "@icomposer/icomposer-verify", "run", "test"]);
run(resolve(root, "packages/insuremo-service/node_modules/.bin/tsx"), ["--test", "packages/insuremo-service/test/profile-context.test.ts", "packages/icomposer-code-intelligence/test/task051-mvp.test.ts"], { TSX_TSCONFIG_PATH: resolve(root, "tsconfig.base.json") });
run("pnpm", ["--filter", "@icomposer/workbench", "run", "test"]);
run("pnpm", ["test:git-dist"]);
