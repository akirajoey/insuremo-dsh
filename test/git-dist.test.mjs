/**
 * TASK-075 tests for the tracked prebuilt plugin directory
 * (`git-dist/icomposer-workbench/`): run with `pnpm test:git-dist`.
 *
 * Covered: required tracked-file manifest, install-manifest safety (no
 * lifecycle scripts, no devDependencies, no file:/workspace: references),
 * built JS with no TypeScript imports, bundle self-containment, parity with
 * a fresh source materialization (drift, compared through the deterministic
 * normalizer) and with the release tarball payload when one has been packed,
 * and a host-path scan. The tracked-in-git gate itself is proven by a clean
 * checkout in CI plus `scripts/check-git-dist.mjs` (which also fails when
 * the directory is git-ignored); this test never runs git write commands.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directoriesDiffer, materializePayload, normalizeForCompare, repoRoot } from "../scripts/dist-payload.mjs";

const gitDist = join(repoRoot, "git-dist", "icomposer-workbench");

const walk = dir => readdirSync(dir).flatMap(name => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

test("git-dist exists with the required tracked file manifest", () => {
  for (const required of ["package.json", "cordis.patch.yml", "README.md", "lib/index.js", "lib/client.js", "lib/assets/insuremo-globe.png"]) {
    assert.equal(existsSync(join(gitDist, required)), true, `missing ${required}`);
  }
  const libIgnored = (() => {
    try {
      execFileSync("git", ["check-ignore", "-q", join(gitDist, "lib", "index.js")], { cwd: repoRoot, stdio: "ignore" });
      return true;
    } catch {
      return false; // check-ignore exits non-zero when the path is NOT ignored
    }
  })();
  assert.equal(libIgnored, false, "git-dist lib must not be git-ignored (it would vanish from clones)");
});

test("install manifest is safe: no scripts, no devDependencies, no file:/workspace: references", () => {
  const manifest = JSON.parse(readFileSync(join(gitDist, "package.json"), "utf8"));
  assert.deepEqual(manifest.scripts ?? {}, {});
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.private, undefined);
  assert.equal(typeof manifest.main, "string");
  assert.ok(manifest.exports["."], "exports must expose the root entry");
  assert.ok(manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0, "peer contract must stay declared");
  for (const file of walk(gitDist).filter(path => path.endsWith(".json"))) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /"(?:file|workspace):[^"]*"/u, `${file} contains a file:/workspace: reference`);
  }
});

test("built JS never imports TypeScript sources", () => {
  for (const file of walk(join(gitDist, "lib")).filter(path => path.endsWith(".js"))) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(?:from|import)\s+["'][^"']+\.(?:ts|tsx|mts|cts)["']/u, `${file} imports a TypeScript source`);
  }
});

test("bundle payload is self-contained: patch, README, and entry exports resolve", () => {
  const manifest = JSON.parse(readFileSync(join(gitDist, "package.json"), "utf8"));
  for (const target of Object.values(manifest.exports)) {
    const resolved = join(gitDist, target);
    assert.equal(existsSync(resolved), true, `export target missing: ${target}`);
  }
  const patch = readFileSync(join(gitDist, "cordis.patch.yml"), "utf8");
  assert.match(patch, /^-\s/u, "cordis.patch.yml must stay a top-level YAML patch list");
});

test("git-dist matches a fresh source materialization (no drift)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "git-dist-test-"));
  try {
    await materializePayload(join(temp, "fresh"), { stripScripts: true });
    const drift = await directoriesDiffer(join(temp, "fresh"), gitDist, normalizeForCompare);
    assert.equal(drift, null, drift ?? "drift");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("git-dist payload matches the packed release tarball (when present)", async () => {
  const tgz = join(repoRoot, "dist-release", "icomposer-workbench-0.1.0.tgz");
  if (!existsSync(tgz)) return; // tarball parity is enforced in CI after pack:dist
  const temp = mkdtempSync(join(tmpdir(), "git-dist-tgz-"));
  try {
    execFileSync("tar", ["-xzf", tgz, "-C", temp]);
    const extracted = join(temp, "package");
    // Payload scope: executable lib/ + the bundle patch + manifest semantics.
    // README.md is documentation, tracked at source by the drift gate; a
    // pinned release tarball legitimately lags the current docs between
    // releases, so it is excluded from this comparison (never from the
    // payload: lib/ and cordis.patch.yml must match byte-for-byte after
    // CSS-module order normalization).
    const drift = await directoriesDiffer(extracted, gitDist, (name, bytes) => {
      const normalized = normalizeForCompare(name, bytes);
      if (name === "package.json") {
        const manifest = JSON.parse(normalized.toString("utf8"));
        delete manifest.scripts; // git-dist strips all scripts; the tgz keeps a no-op prepare
        delete manifest.private; // git-dist strips packaging metadata (new pack-dist does the same)
        return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      return normalized;
    }, { skip: ["README.md"] });
    assert.equal(drift, null, drift ?? "tgz payload drift");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("no host-absolute paths anywhere in the tracked payload", () => {
  const needles = [/\/Users\//u, /\/opt\/homebrew/u, /\/private\/var/u, /\/var\/folders/u, /[A-Z]:\\\\Users\\\\/u];
  for (const file of walk(gitDist)) {
    if (/\.(?:png)$|assets\//u.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const needle of needles) assert.doesNotMatch(text, needle, `${file} contains a host path`);
  }
});
