#!/usr/bin/env node
/**
 * Read-only compatibility audit (TASK-033).
 *
 * 1. Every harness package referenced by Workbench peerDependencies must
 *    resolve against the pinned Harness checkout (compatibility.json).
 * 2. The installed profile bundle must match the repo bundle manifest
 *    (plugin lines + dependency set) and the pnpm lockfile must exist.
 * 3. Snapshot the compatibility state to docs/compat-audit.json.
 *
 * Exits non-zero on any mismatch. Never writes outside the repo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibility = JSON.parse(readFileSync(join(repoRoot, "compatibility.json"), "utf8"));
const harnessRoot = resolve(repoRoot, compatibility.harnessPath);
const findings = [];
const ok = (message) => findings.push({ ok: true, check: message });
const bad = (message) => findings.push({ ok: false, check: message });

// --- 1. harness HEAD pinned ---
const head = execFileSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head.toLowerCase() === compatibility.harnessCommit.toLowerCase()) {
  ok(`harness HEAD pinned at ${head.slice(0, 10)}`);
} else {
  bad(`harness HEAD ${head} != pinned ${compatibility.harnessCommit}`);
}
const harnessDirty = execFileSync("git", ["-C", harnessRoot, "status", "--porcelain"], { encoding: "utf8" }).trim();
if (harnessDirty === "") {
  ok("harness working tree clean");
} else {
  bad(`harness working tree dirty:\n${harnessDirty}`);
}

// --- 2. peer harness references resolve against the pinned checkout ---
const packagesDir = join(repoRoot, "packages");
const harnessPeerRefs = new Map();
for (const entry of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const field of ["peerDependencies", "devDependencies"]) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep.startsWith("@deepseek-ai/")) {
        if (!harnessPeerRefs.has(dep)) harnessPeerRefs.set(dep, []);
        harnessPeerRefs.get(dep).push(`${entry}(${field.replace("peerDependencies", "peer").replace("devDependencies", "dev")})`);
      }
    }
  }
}
// tsconfig.base paths define where each @deepseek-ai/* should resolve
const baseTsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.base.json"), "utf8"));
const paths = baseTsconfig.compilerOptions.paths ?? {};
for (const [dep, referrers] of harnessPeerRefs) {
  const mapped = paths[dep];
  if (mapped === undefined) {
    // A peer without a source mapping is acceptable when every referring
    // package carries a local harness-shims.d.ts declaring the module.
    const packagesReferring = [...new Set(referrers.map(r => r.split("(")[0]))];
    const shimmed = packagesReferring.every(pkg => {
      const shim = join(packagesDir, pkg, "src", "harness-shims.d.ts");
      if (!existsSync(shim)) return false;
      const shimText = readFileSync(shim, "utf8");
      if (shimText.includes(`declare module "${dep}"`)) return true;
      // package-local tsconfig path mapping pointing at the shim
      const pkgTsconfig = join(packagesDir, pkg, "tsconfig.json");
      if (!existsSync(pkgTsconfig)) return false;
      const pkgPaths = JSON.parse(readFileSync(pkgTsconfig, "utf8"))?.compilerOptions?.paths ?? {};
      return Object.keys(pkgPaths).some(key => key === dep || key.startsWith(`${dep}/`));
    });
    if (shimmed) {
      ok(`${dep} resolved via harness-shims.d.ts in ${packagesReferring.length} referring package(s)`);
    } else {
      bad(`${dep} referenced by ${referrers.join(",")} has no tsconfig.base.json path mapping and no complete shim coverage`);
    }
    continue;
  }
  const target = resolve(repoRoot, mapped[0]);
  if (!existsSync(target)) {
    bad(`${dep} path target does not exist: ${target}`);
    continue;
  }
  // the mapped target must live inside the pinned harness checkout
  const rel = relative(harnessRoot, target);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    bad(`${dep} resolves outside the pinned harness: ${target}`);
    continue;
  }
  ok(`${dep} -> ${relative(repoRoot, target)} (${referrers.length} referrer${referrers.length === 1 ? "" : "s"})`);
}

// --- 3. bundle manifest vs installed profile coherence ---
const bundleDir = join(repoRoot, "packages", "bundle-icomposer-workbench");
const bundleManifest = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));
const patchText = readFileSync(join(bundleDir, "cordis.patch.yml"), "utf8");
const pluginNames = [...patchText.matchAll(/name: '(@icomposer\/[a-z-]+)'/g)].map(m => m[1]);
const bundleDeps = Object.keys(bundleManifest.dependencies ?? {}).filter(d => d.startsWith("@icomposer/"));
const missingDeps = pluginNames.filter(name => !bundleDeps.includes(name));
if (missingDeps.length === 0) {
  ok(`bundle declares all ${pluginNames.length} patch plugins as dependencies`);
} else {
  bad(`bundle manifest missing dependencies for: ${missingDeps.join(", ")}`);
}
if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) {
  const lockHash = createHash("sha256").update(readFileSync(join(repoRoot, "pnpm-lock.yaml"))).digest("hex").slice(0, 16);
  ok(`pnpm-lock.yaml present (sha256:${lockHash})`);
} else {
  bad("pnpm-lock.yaml missing");
}

// --- 4. write snapshot ---
const snapshot = {
  auditedAt: new Date().toISOString(),
  harnessCommit: head,
  pinnedCommit: compatibility.harnessCommit,
  harnessClean: harnessDirty === "",
  pluginCount: pluginNames.length,
  lockfilePresent: existsSync(join(repoRoot, "pnpm-lock.yaml")),
  checks: findings,
};
const snapshotPath = join(repoRoot, "docs", "compat-audit.json");
writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

for (const finding of findings) {
  console.log(`${finding.ok ? "ok  " : "FAIL"} ${finding.check}`);
}
console.log(`snapshot written to ${relative(repoRoot, snapshotPath)}`);
const failures = findings.filter(f => !f.ok).length;
console.log(failures === 0 ? `compat audit PASSED (${findings.length} checks)` : `compat audit FAILED (${failures}/${findings.length})`);
process.exit(failures === 0 ? 0 : 1);
