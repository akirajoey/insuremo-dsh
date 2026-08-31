#!/usr/bin/env node
/**
 * TASK-075 end-to-end proof, Plugin Only (per review): the isolated install
 * goes through the REAL stock DSH CLI forwarding chain
 * (`dsh plugin --profile web add <spec>` → pnpm in the profile directory →
 * bundle reconciliation), never through desktop helper code.
 *
 * Steps:
 *  1. Build a temp bare git remote whose working tree carries the real
 *     `git-dist/icomposer-workbench` payload (committed inside the temp
 *     repo only — the real repository is never touched by git).
 *  2. Create an isolated DSH home whose absolute path contains spaces and
 *     CJK characters (Windows-safe by construction), then run the stock
 *     `dsh` CLI to install the rc.7 web runtime deps and the plugin via the
 *     pinned selector `git+file://…#<commit-sha>&path:git-dist/icomposer-workbench`
 *     (identical selector parsing to the documented `github:…#<sha>&path:…`).
 *  3. Assert: the install resolves to a real physical copy INSIDE the
 *     profile directory (pnpm symlink into its own .pnpm store is fine; a
 *     link back into the source repo is not), no lifecycle scripts in the
 *     installed manifest, no allowBuilds in the profile workspace, no
 *     deepseek-harness sibling anywhere under the profile, bundle layer
 *     reconciliation, and payload parity with the tracked directory.
 *
 * Stock dsh resolution: DSH_STOCK_DSH_BIN overrides; otherwise the sibling
 * checkout's node_modules (dev) or `pnpm add @deepseek-ai/dsh@0.1.0-rc.7`
 * into a temp prefix (CI).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitDist = join(repoRoot, "git-dist", "icomposer-workbench");
const failures = [];
const fail = message => failures.push(message);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr ?? "").slice(-800)}`);
  return result;
};

if (!existsSync(gitDist)) {
  console.error("[git-install-e2e] FAIL: git-dist/icomposer-workbench missing — run pnpm pack:git-dist");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "git-install-e2e-"));
const home = join(work, "dsh e2e 中文 目录", "home"); // spaces + CJK, Windows-safe charset

function stockDshBin() {
  if (process.env.DSH_STOCK_DSH_BIN !== undefined && process.env.DSH_STOCK_DSH_BIN !== "") return process.env.DSH_STOCK_DSH_BIN;
  const sibling = resolve(repoRoot, "..", "insuremo-dsh-desktop", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(sibling)) return sibling;
  const prefix = join(work, "stock-dsh");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "stock-dsh-holder", private: true }));
  run("pnpm", ["add", "--ignore-scripts", "@deepseek-ai/dsh@0.1.0-rc.7"], { cwd: prefix });
  return join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

const dsh = stockDshBin();

function walkFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walkFiles(full) : [full];
  });
}

try {
  // 1) Temp bare remote carrying the real payload.
  const remoteWork = join(work, "repo-work");
  const remote = join(work, "remote.git");
  const git = (...args) => run("git", args, { cwd: remoteWork });
  run("git", ["init", "-q", "--bare", remote]);
  run("git", ["init", "-q", "-b", "main", remoteWork]);
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "git-dist e2e");
  mkdirSync(join(remoteWork, "git-dist"));
  cpSync(gitDist, join(remoteWork, "git-dist", "icomposer-workbench"), { recursive: true });
  writeFileSync(join(remoteWork, ".gitignore"), "node_modules/\nlib/\n!git-dist/icomposer-workbench/lib/\n");
  git("add", "-A", "-f", "git-dist");
  git("commit", "-qm", "git-dist e2e payload");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "HEAD");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteWork, encoding: "utf8" }).trim();

  // 2) Real stock chain, Plugin Only: the first add initializes the rc.7
  // web profile; runtime deps are intentionally NOT installed here (their
  // native builds are the desktop runtime's concern, not the plugin's).
  const env = { ...process.env, DSH_HOME: home };
  const dshRun = (...args) => run("node", [dsh, ...args], { env, cwd: work });
  const spec = `git+file://${remote}#${commit}&path:git-dist/icomposer-workbench`;
  dshRun("plugin", "--profile", "web", "add", spec);

  // 3) Assertions.
  const profileDir = join(home, "profiles", "web");
  const installed = join(profileDir, "node_modules", "@icomposer", "workbench");
  if (!existsSync(installed)) fail("plugin was not installed into the isolated profile");
  if (installedInfoMissing(installed)) fail("installed plugin lib/index.js missing");
  // pnpm materializes installs as a symlink into the profile's own .pnpm
  // virtual store: the resolved real files MUST stay inside the profile
  // directory — a link back into the source checkout would be a leak.
  const real = realpathSync(installed);
  const profileReal = realpathSync(profileDir);
  if (!real.startsWith(profileReal)) fail(`install leaked outside the profile: ${real}`);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (Object.keys(installedManifest.scripts ?? {}).length > 0) fail(`installed manifest carries scripts: ${JSON.stringify(installedManifest.scripts)}`);
  const workspaceText = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
  if (/allowBuilds/u.test(workspaceText)) fail("profile workspace required allowBuilds — the prebuilt payload must not need build scripts");
  const profileManifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  const bundles = profileManifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes("@icomposer/workbench")) fail(`bundle layer did not reconcile: ${JSON.stringify(bundles)}`);
  const installedFiles = walkFiles(installed).map(path => relative(installed, path)).sort();
  const sourceFiles = walkFiles(gitDist).map(path => relative(gitDist, path)).sort();
  if (installedFiles.join("\n") !== sourceFiles.join("\n")) fail("installed payload file set differs from git-dist");
  for (const name of sourceFiles) {
    if (!/\.(?:js|json|yml|md)$/u.test(name)) continue;
    if (readFileSync(join(installed, name), "utf8") !== readFileSync(join(gitDist, name), "utf8")) fail(`payload content differs: ${name}`);
  }
  const harnessSiblings = walkFiles(join(profileDir, "node_modules")).filter(path => path.includes("deepseek-harness"));
  if (harnessSiblings.length > 0) fail(`deepseek-harness siblings leaked into the profile: ${harnessSiblings[0]}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}

function installedInfoMissing(path) {
  return lstatSync(join(path, "lib", "index.js"), { throwIfNoEntry: false }) === undefined;
}

if (failures.length > 0) {
  for (const message of failures) console.error(`[git-install-e2e] FAIL: ${message}`);
  process.exit(1);
}
console.log("[git-install-e2e] PASS: stock dsh plugin chain installed the pinned git-dist payload cleanly");
