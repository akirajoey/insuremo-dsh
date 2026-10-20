#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!root.includes("/upgrade-dsh-0.2.1/")) throw new Error("Use the isolated upgrade worktree");
const sandbox = resolve(root, ".dsh-home/migration");
const home = resolve(process.env.DSH_HOME || sandbox);
const within = relative(resolve(root, ".."), home);
if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("DSH_HOME must be inside the isolated upgrade workspace");
const tools = resolve(root, "../deepseek-harness/.migration-tools/node_modules");
const manifest = JSON.parse(readFileSync(resolve(tools, "@deepseek-ai/dsh/package.json"), "utf8"));
if (manifest.version !== "0.2.1-rc.2") throw new Error("Expected isolated npm dsh 0.2.1-rc.2");
const osHome = resolve(home, "os-home");
const cwd = resolve(home, "workspace");
const bin = resolve(home, "bin");
for (const dir of [home, osHome, cwd, bin]) mkdirSync(dir, { recursive: true });
const fixture = resolve(root, "test/fixtures/migration-imo.mjs");
chmodSync(fixture, 0o755);
// Absolute command config prevents terminal PATH discovery from selecting the real IMO CLI.
const patch = resolve(home, "fixture.patch.yml");
writeFileSync(patch, JSON.stringify([{ id: "icomposer-workbench", config: { insuremoService: { command: fixture } } }], null, 2));
const args = process.argv.slice(2);
if (args[0] && !args[0].startsWith("-") && args[0] !== "plugin") args.unshift("--profile");
const launching = args.length > 0 && !["plugin", "--help", "-h", "--version", "-V"].includes(args[0]);
const env = {
  PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: osHome, USERPROFILE: osHome, DSH_HOME: home,
  TMPDIR: process.env.TMPDIR || "/tmp", LANG: "en_US.UTF-8",
};
const child = spawn(process.execPath, [resolve(tools, "@deepseek-ai/dsh/lib/bin.js"),
  ...(launching ? ["--patch", patch] : []), ...(args.length ? args : ["--help"])], { cwd, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
