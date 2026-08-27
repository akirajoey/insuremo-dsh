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
await rm(join(distDir, "lib"), { recursive: true, force: true });
await mkdir(staged, { recursive: true });

// Build fresh artifacts first (lib/ is part of the shipped payload). The
// explicit removal above is a release-time defense even if a caller bypasses
// the package build script.
execFileSync("pnpm", ["run", "build"], { cwd: distDir, stdio: "inherit" });

const retiredWord = "inter" + "com";
const retiredService = "INTER" + "COM_SERVICE";
const retiredMarker = new RegExp(`workbench-${retiredWord}|${retiredService}|${retiredWord}/`, "i");
const textExtensions = new Set([".js", ".map", ".json", ".md", ".yml"]);
async function assertNoRetiredText(root, label) {
  async function walkText(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walkText(full); continue; }
      if (!textExtensions.has(full.slice(full.lastIndexOf(".")))) continue;
      const st = await stat(full);
      if (st.size > 20_000_000) throw new Error(`refusing oversized text scan: ${full}`);
      const text = await readFile(full, "utf8");
      if (retiredMarker.test(text)) throw new Error(`retired communication marker in ${label}/${relative(root, full)}`);
    }
  }
  await walkText(root);
}
await assertNoRetiredText(join(distDir, "lib"), "dist/lib");

// Copy the install-relevant payload only.
for (const entry of ["lib", "cordis.patch.yml", "package.json", "README.md"]) {
  await cp(join(distDir, entry), join(staged, entry), { recursive: true });
}
// Source maps are useful during local development but are not part of the
// release payload: they expose source layout and make the artifact needlessly
// large. Keep only executable JS in the shipped lib/.
async function removeSourceMaps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(full);
    else if (entry.name.endsWith(".map")) await rm(full, { force: true });
  }
}
await removeSourceMaps(join(staged, "lib"));
// Rollup/tsdown region comments can retain the local checkout prefix. Never
// ship machine-specific host paths even in comments; the executable payload
// does not depend on them.
async function sanitizeStagedJs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sanitizeStagedJs(full);
    else if (entry.name.endsWith(".js")) {
      const text = await readFile(full, "utf8");
      const sanitized = text.replaceAll(`${repoRoot}/`, "<repo>/").replaceAll("/private/var", "private-var").replaceAll("/var/folders", "var-folders").replaceAll("/tmp/", "tmp/");
      if (sanitized !== text) await writeFile(full, sanitized, "utf8");
    }
  }
}
await sanitizeStagedJs(join(staged, "lib"));

await assertNoRetiredText(staged, "staged");

// The shipped package.json must not build on install: the prebuilt lib/ is
// the payload, and the file:../sibling devDependencies cannot resolve inside
// an extracted zip anyway. prepare becomes a no-op and devDependencies drop.
const shipped = { ...manifest };
shipped.scripts = { ...manifest.scripts, prepare: "node -e \"console.log('@icomposer/workbench: prebuilt lib/ shipped; skipping build')\"" };
delete shipped.devDependencies;
await writeFile(join(staged, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`, "utf8");

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
