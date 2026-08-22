#!/usr/bin/env node
/**
 * Pack the distributable plugin folder (TASK-034).
 *
 * Produces dist-release/icomposer-workbench-dist/ — a self-contained copy of
 * the dist package with the prebuilt lib/ included — and zips it to
 * dist-release/icomposer-workbench-dist-<version>.zip. Recipients unzip,
 * `cd` in, and run `dsh plugin --profile web add .`.
 *
 * The zip carries only the dist package itself (no sibling sources, no
 * node_modules): the prebuilt lib/ artifacts are install-ready, so pnpm's
 * prepare can be skipped (files already present) — verify-standard-install
 * proves this end to end.
 */
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "packages", "icomposer-workbench-dist");
const releaseDir = join(repoRoot, "dist-release");
const manifest = JSON.parse(await readFile(join(distDir, "package.json"), "utf8"));
const version = manifest.version;
const staged = join(releaseDir, "icomposer-workbench-dist");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(staged, { recursive: true });

// Build fresh artifacts first (lib/ is part of the shipped payload).
execFileSync("pnpm", ["run", "build"], { cwd: distDir, stdio: "inherit" });

// Copy the install-relevant payload only.
for (const entry of ["lib", "cordis.patch.yml", "package.json", "README.md"]) {
  await cp(join(distDir, entry), join(staged, entry), { recursive: true });
}

// The shipped package.json must not build on install: the prebuilt lib/ is
// the payload, and the file:../sibling devDependencies cannot resolve inside
// an extracted zip anyway. prepare becomes a no-op and devDependencies drop.
const shipped = { ...manifest };
shipped.scripts = { ...manifest.scripts, prepare: "node -e \"console.log('@icomposer/workbench: prebuilt lib/ shipped; skipping build')\"" };
delete shipped.devDependencies;
await writeFile(join(staged, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`, "utf8");

// Manifest listing + zip.
const list = [];
async function walk(dir, prefix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { await walk(full, rel); continue; }
    const st = await stat(full);
    list.push({ path: rel, bytes: st.size });
  }
}
await walk(staged, "");
const zipName = `icomposer-workbench-dist-${version}.zip`;
execFileSync("zip", ["-r", "-q", zipName, "icomposer-workbench-dist"], { cwd: releaseDir });

const summary = {
  package: manifest.name,
  version,
  stagedAt: new Date().toISOString(),
  files: list,
  zip: zipName,
};
await writeFile(join(releaseDir, "pack-manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`packed ${list.length} files -> ${join(relative(repoRoot, releaseDir), zipName)}`);
for (const file of list) console.log(`  ${file.path} (${file.bytes} bytes)`);
