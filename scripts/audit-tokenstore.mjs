// P0 (TASK-043 fix #4): production code must never read the imo credential
// store (auth-profiles.json) — it holds access_token material.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BANNED = /auth-profiles\.json|Application Support\/insuremo|\.config\/insuremo|\.insuremo\/auth-profiles/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".dsh-home", "dist-release", "lib", ".pnpm"]);
let failures = 0;
function walk(dir, rel) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    if (rel === "" && entry === "scripts") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, join(rel, entry));
    else if (entry.endsWith(".ts") || entry.endsWith(".mts") || entry.endsWith(".tsx") || entry.endsWith(".mjs")) {
      const content = readFileSync(full, "utf8");
      if (BANNED.test(content)) {
        failures += 1;
        console.error(`BANNED token-store reference in ${join(rel, entry)}`);
      }
    }
  }
}
walk(ROOT, "");
if (failures > 0) { console.error(`token-store audit FAILED (${failures})`); process.exit(1); }
console.log("token-store audit PASSED: no credential-store reads in production code");
