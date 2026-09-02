import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalizeCssSourceRegions, repoRoot } from "../scripts/dist-payload.mjs";

const script = join(repoRoot, "scripts", "pack-git-dist.mjs");
const runPack = (root, extra = {}) => spawnSync(process.execPath, [script], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, DSH_GIT_DIST_DIR: join(root, "git-dist"), ...extra },
});
const temporaryNames = root => readdirSync(root).filter(name => name.startsWith(".backup-") || name.startsWith(".staging-"));
const payloadFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? payloadFiles(full) : [full];
});

test("CSS source regions canonicalize POSIX and Windows checkout paths", () => {
  const input = Buffer.from([
    String.raw`//#region \0dsh-css:/Users/worker/workbench/packages/ui/a.css.mjs`,
    String.raw`//#region \0dsh-css:D:\\dsh\\workbench-src\\packages\\ui\\b.css.mjs`,
    String.raw`//#region \0dsh-css:asset`,
  ].join("\n"));
  const output = canonicalizeCssSourceRegions(input).toString("utf8");
  assert.equal(output, [
    String.raw`//#region \0dsh-css:asset`,
    String.raw`//#region \0dsh-css:asset`,
    String.raw`//#region \0dsh-css:asset`,
  ].join("\n"));
});

test("successful git-dist refreshes leave no backup or staging directories", () => {
  const root = mkdtempSync(join(tmpdir(), "git-dist swap 中文 "));
  try {
    for (let index = 0; index < 3; index++) {
      const result = runPack(root);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(temporaryNames(join(root, "git-dist")), []);
    }
    const target = join(root, "git-dist", "icomposer-workbench");
    assert.equal(payloadFiles(target).length, 10, "expected the ten-file prebuilt payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("second rename failure restores the complete previous target and temps", () => {
  const root = mkdtempSync(join(tmpdir(), "git-dist rename-failure-"));
  const target = join(root, "git-dist", "icomposer-workbench");
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel.txt"), "previous target\n");
    const result = runPack(root, { DSH_GIT_DIST_INJECT_RENAME_FAILURE: "1" });
    assert.notEqual(result.status, 0, "injected swap failure must be non-zero");
    assert.match(`${result.stdout}\n${result.stderr}`, /injected staging-to-target rename failure/u);
    assert.equal(readFileSync(join(target, "sentinel.txt"), "utf8"), "previous target\n");
    assert.deepEqual(temporaryNames(join(root, "git-dist")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure is non-zero and retains a diagnostic backup", () => {
  const root = mkdtempSync(join(tmpdir(), "git-dist cleanup-failure-"));
  const target = join(root, "git-dist", "icomposer-workbench");
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel.txt"), "previous target\n");
    const result = runPack(root, { DSH_GIT_DIST_INJECT_CLEANUP_FAILURE: "1" });
    assert.notEqual(result.status, 0, "cleanup failure must not claim success");
    assert.match(`${result.stdout}\n${result.stderr}`, /temporary cleanup failed|cleanup failure/u);
    assert.equal(existsSync(join(target, "lib", "index.js")), true, "new target remains installed");
    const backups = readdirSync(join(root, "git-dist")).filter(name => name.startsWith(".backup-"));
    assert.equal(backups.length, 1, "failed cleanup retains exactly one diagnostic backup");
    assert.deepEqual(readdirSync(join(root, "git-dist")).filter(name => name.startsWith(".staging-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
