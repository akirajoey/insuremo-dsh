#!/usr/bin/env node
/**
 * Refresh the tracked prebuilt plugin directory (TASK-075).
 *
 * Materializes the same payload as the release tarball into
 * `git-dist/icomposer-workbench/` — the directory GitHub installs consume via
 * `github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench`.
 * Unlike the tarball, the package.json here has NO scripts at all: GitHub
 * `#path:` installs run the checkout directory directly and must never
 * trigger a build (which would also trip pnpm's allowBuilds gate).
 *
 * The refresh is atomic-ish and Windows-safe: the new payload is built in a
 * staging directory, the previous target is moved to a backup name (Windows
 * cannot rename over a non-empty directory), the staging directory is renamed
 * into place, and the backup is removed only after the successful swap in a
 * `finally` block. If the swap fails, the backup is restored. If temporary
 * cleanup fails, this process exits non-zero and retains the diagnostic backup
 * instead of claiming success. No git commands are run.
 */
import { mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { materializePayload, repoRoot } from "./dist-payload.mjs";

const gitDistDir = process.env.DSH_GIT_DIST_DIR ?? join(repoRoot, "git-dist");
const target = join(gitDistDir, "icomposer-workbench");
const suffix = `${process.pid}-${Date.now()}`;
const staging = join(gitDistDir, `.staging-${suffix}`);
const backup = join(gitDistDir, `.backup-${suffix}`);
const injectRenameFailure = process.env.DSH_GIT_DIST_INJECT_RENAME_FAILURE === "1";
const injectCleanupFailure = process.env.DSH_GIT_DIST_INJECT_CLEANUP_FAILURE === "1";

await mkdir(gitDistDir, { recursive: true });

let backupCreated = false;
let preserveBackup = false;
let cleanupFailureInjected = false;

async function removeTemporary(path, label) {
  if (injectCleanupFailure && label === "backup" && !cleanupFailureInjected) {
    cleanupFailureInjected = true;
    throw new Error(`injected ${label} cleanup failure; retaining ${relative(repoRoot, path)}`);
  }
  await rm(path, { recursive: true, force: true });
}

try {
  await materializePayload(staging, { stripScripts: true });
  if (existsSync(target)) {
    await rename(target, backup);
    backupCreated = true;
  }
  try {
    if (injectRenameFailure) throw new Error("injected staging-to-target rename failure");
    await rename(staging, target);
  } catch (error) {
    if (backupCreated) {
      try {
        await rename(backup, target);
        backupCreated = false;
      } catch (restoreError) {
        preserveBackup = true;
        throw new Error(`git-dist swap failed and backup restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}; backup retained at ${relative(repoRoot, backup)}`);
      }
    }
    throw error;
  }
} finally {
  const cleanupErrors = [];
  try {
    await removeTemporary(staging, "staging");
  } catch (error) {
    cleanupErrors.push(`staging cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Keep backupCreated true until rm succeeds. This prevents the successful
  // path from leaking a backup and preserves it when cleanup itself fails.
  if (backupCreated && !preserveBackup) {
    try {
      await removeTemporary(backup, "backup");
      backupCreated = false;
    } catch (error) {
      preserveBackup = true;
      cleanupErrors.push(`backup cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`git-dist temporary cleanup failed: ${cleanupErrors.join("; ")}${preserveBackup ? `; diagnostic backup retained at ${relative(repoRoot, backup)}` : ""}`);
  }
}

console.log(`refreshed ${relative(repoRoot, target)} (${existsSync(join(target, "lib")) ? "lib present" : "LIB MISSING"})`);
