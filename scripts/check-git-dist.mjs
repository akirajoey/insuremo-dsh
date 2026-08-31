#!/usr/bin/env node
/**
 * Drift gate for the tracked prebuilt plugin directory (TASK-075).
 *
 * Re-materializes the payload into a temp directory and compares it
 * byte-for-byte against `git-dist/icomposer-workbench/`. Fails when the
 * directory is missing, empty, ignored by git, or differs from a fresh
 * materialization in any file. Runs no git write commands (`git
 * check-ignore` is a read-only query); CI's clean checkout is what proves
 * the directory is actually tracked once the maintainer commits it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directoriesDiffer, materializePayload, normalizeForCompare, repoRoot } from "./dist-payload.mjs";

const target = join(repoRoot, "git-dist", "icomposer-workbench");
const failures = [];
const fail = message => failures.push(message);

if (!existsSync(target)) {
  fail("git-dist/icomposer-workbench is missing — run: pnpm pack:git-dist");
} else {
  const entries = readdirSync(target);
  if (entries.length === 0) fail("git-dist/icomposer-workbench is empty — run: pnpm pack:git-dist");
  if (!existsSync(join(target, "lib", "index.js"))) fail("git-dist/icomposer-workbench/lib/index.js is missing");
  // Ignored files would silently vanish from a GitHub clone and break #path:
  // installs; the nested lib/ must be force-re-included in .gitignore.
  const probe = join(target, "lib", "index.js");
  if (existsSync(probe)) {
    let ignored = true;
    try {
      execFileSync("git", ["check-ignore", "-q", probe], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      ignored = false; // check-ignore exits non-zero when the path is NOT ignored
    }
    if (ignored) fail("git-dist lib is git-ignored (would be absent from clones) — fix .gitignore re-inclusion");
  }
  const temp = mkdtempSync(join(tmpdir(), "git-dist-check-"));
  try {
    await materializePayload(join(temp, "fresh"), { stripScripts: true });
    if (existsSync(target)) {
      const drift = await directoriesDiffer(join(temp, "fresh"), target, normalizeForCompare);
      if (drift !== null) fail(`git-dist drifted from source: ${drift} — run: pnpm pack:git-dist`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`[check-git-dist] FAIL: ${message}`);
  process.exit(1);
}
console.log("[check-git-dist] git-dist/icomposer-workbench matches the source payload");
