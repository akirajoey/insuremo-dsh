#!/usr/bin/env node
/**
 * Read-only secrets/redaction audit (TASK-033).
 *
 * Scans the repository source and (optionally) an e2e DSH_HOME artifact
 * directory for:
 *   - token-shaped strings (long base64/hex/JWT-like, excluding sha256:
 *     digests which the Workbench emits by design);
 *   - canary secrets previously used in tests ("sekret-token",
 *     "e2e-fake-token" are allowed fakes listed explicitly);
 *   - absolute home paths outside the allowlist (harness checkout, project
 *     directories, temp dirs).
 *
 * Exits non-zero when anything outside the allowlists is found and prints
 * the hit list. Never writes anywhere.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname_(fileURLToPath(import.meta.url)), "..");
function dirname_(p) { return p.slice(0, p.lastIndexOf("/")); }

const SCAN_ROOT = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".dsh-home", "coverage"]);

// Strings that look like tokens but are deliberate, non-secret fixtures.
const ALLOWED_FAKES = new Set([
  "sekret-token",
  "e2e-fake-token",
  "fake-token",
  "test-token",
  "PLACEHOLDER_TOKEN",
]);
const ALLOWED_HOME_PREFIXES = [
  join(homedir(), "dsh"),
  "/Users/junjie.zhang/skills",
  "/private/var/folders",
  "/var/folders",
  "/tmp",
];

const TOKEN_PATTERNS = [
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { name: "long-bearer", pattern: /(?:Bearer|bearer)\s+([A-Za-z0-9._~+/=-]{40,})/g },
  { name: "opaque-long", pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g },
  { name: "hex-64", pattern: /\b[0-9a-fA-F]{64}\b/g },
];
const hits = [];

function scanFile(path, relPath) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const { name, pattern } of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const captured = match[1] ?? match[0];
      // by-design digests are not secrets: sha256:/sha512- prefixed values
      const start = Math.max(0, match.index - 8);
      const prefix8 = text.slice(start, match.index);
      if (prefix8.endsWith("sha256:")) continue;
      if (prefix8.endsWith("sha512-")) continue;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineForMatch = text.slice(lineStart, Math.min(text.length, match.index));
      if (lineForMatch.includes("integrity") || lineForMatch.includes("sha512-")) continue;
      if (relPath === "pnpm-lock.yaml") continue; // registry integrity hashes only
      if (ALLOWED_FAKES.has(captured)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const lineText = text.split("\n")[line - 1]?.trim().slice(0, 120) ?? "";
      hits.push({ file: relPath, line, kind: name, sample: `${captured.slice(0, 12)}…(${captured.length} chars)`, context: lineText });
    }
  }
  for (const fake of ALLOWED_FAKES) {
    if (text.includes(fake)) {
      // allowed fakes are recorded informationally only if they appear in
      // non-test sources; tests may use them freely.
      const deliberateFakeZone = relPath.includes("/test/") || relPath.startsWith("test/") || relPath.includes(".tmp.") || relPath.startsWith("scripts/audit-secrets") || relPath.startsWith("packages/icomposer-workbench-e2e/");
      if (!deliberateFakeZone) {
        hits.push({ file: relPath, line: 0, kind: "fake-token-in-prod", sample: fake, context: "deliberate fake outside tests" });
      }
    }
  }
  // absolute home paths outside the allowlist
  const homePrefix = `${homedir()}/`;
  for (const match of text.matchAll(new RegExp(`${homePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9._/@-]+`, "g"))) {
    const value = match[0];
    if (ALLOWED_HOME_PREFIXES.some(prefix => value.startsWith(prefix))) continue;
    // documentation files may cite historical research paths
    if (relPath.endsWith("README.md") || relPath.startsWith("docs/")) continue;
    const line = text.slice(0, match.index).split("\n").length;
    const lineText = text.split("\n")[line - 1]?.trim().slice(0, 120) ?? "";
    hits.push({ file: relPath, line, kind: "home-path", sample: value.slice(0, 60), context: lineText });
  }
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== "." && !entry.name.startsWith("..")) {
      if (entry.name === ".git" || entry.name === ".dsh-home") continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (entry.name.endsWith(".tmp.mts") || entry.name.endsWith(".tmp.ts")) continue; // deliberate real-smoke scripts reference real paths
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    scanFile(full, relative(SCAN_ROOT, full));
  }
}

walk(SCAN_ROOT);

if (hits.length === 0) {
  console.log(`secrets audit PASSED: no findings under ${relative(repoRoot, SCAN_ROOT) || "."}`);
  process.exit(0);
}
console.error(`secrets audit FAILED: ${hits.length} finding(s)`);
for (const hit of hits.slice(0, 50)) {
  console.error(`- [${hit.kind}] ${hit.file}:${hit.line} ${hit.sample} | ${hit.context}`);
}
if (hits.length > 50) console.error(`…and ${hits.length - 50} more`);
process.exit(1);
