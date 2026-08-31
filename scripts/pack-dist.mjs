#!/usr/bin/env node
/**
 * Pack the distributable plugin folder (TASK-034).
 *
 * Produces dist-release/icomposer-workbench-dist/ (staging copy with the
 * prebuilt lib/) and the PRIMARY artifact dist-release/icomposer-workbench-<version>.tgz
 * (npm pack of the staging copy). Recipients install with
 * `dsh plugin --profile web add icomposer-workbench-<version>.tgz`.
 *
 * The tarball is the recommended form: npm-packed tarballs materialize the
 * package physically inside the profile's node_modules, whose ancestor
 * chain lets the dsh loader resolve @deepseek-ai peers. A bare directory
 * `add .` creates a link: install that keeps files at the original
 * location — bare-import resolution from there can fail depending on the
 * surrounding node_modules layout (observed as ERR_MODULE_NOT_FOUND).
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializePayload } from "./dist-payload.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "packages", "icomposer-workbench-dist");
const releaseDir = join(repoRoot, "dist-release");
const manifest = JSON.parse(await readFile(join(distDir, "package.json"), "utf8"));
const version = manifest.version;
const staged = join(releaseDir, "icomposer-workbench-dist");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(staged, { recursive: true });

// Materialize the prebuilt payload via the shared implementation (builds
// lib/ fresh: a release-time defense even if a caller bypasses the build).
const shipped = await materializePayload(staged, { stripScripts: false });
if (shipped.name !== manifest.name || shipped.version !== version) {
  throw new Error("staged manifest drifted from the dist package manifest");
}

// Manifest listing + the tarball (PRIMARY artifact).
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
// npm pack materializes the package physically inside the profile's
// node_modules on install — the only layout whose ancestor chain lets the
// dsh loader resolve @deepseek-ai peers (a directory link: keeps the files
// at the linked location, where bare-import resolution can fail).
const tgzName = `icomposer-workbench-${version}.tgz`;
execFileSync("npm", ["pack", "--silent", "--pack-destination", releaseDir], { cwd: staged });

// Verify tarball contents match the staged payload exactly.
const tgzListing = execFileSync("tar", ["-tzf", join(releaseDir, tgzName)], { encoding: "utf8" })
  .split("\n").map(line => line.trim()).filter(line => line.length > 0 && !line.endsWith("/"))
  .map(line => line.replace(/^package\//, ""));
const stagedPaths = list.map(file => file.path).sort();
const missing = stagedPaths.filter(path => !tgzListing.includes(path));
if (missing.length > 0) throw new Error(`tgz missing staged files: ${missing.join(", ")}`);

const summary = {
  package: manifest.name,
  version,
  stagedAt: new Date().toISOString(),
  files: list,
  tgz: tgzName,
  tgzContents: tgzListing.sort(),
};
await writeFile(join(releaseDir, "pack-manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`packed ${list.length} files -> ${join(relative(repoRoot, releaseDir), tgzName)}`);
for (const file of list) console.log(`  ${file.path} (${file.bytes} bytes)`);
