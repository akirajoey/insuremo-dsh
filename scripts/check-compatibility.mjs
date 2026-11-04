import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPnpm, probePnpm, satisfies, selectTrustedPnpm } from "./pnpm-launch.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compatibilityPath = resolve(repositoryRoot, "compatibility.json");

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
const failures = [];

const harnessPath = resolve(repositoryRoot, compatibility.harnessPath);
if (!existsSync(harnessPath)) {
  failures.push("Pinned Harness directory is not available");
} else {
  const harnessCommit = commandOutput("git", ["-C", harnessPath, "rev-parse", "HEAD"]);
  if (!harnessCommit) {
    failures.push("Unable to read pinned Harness HEAD");
  } else if (harnessCommit.toLowerCase() !== compatibility.harnessCommit.toLowerCase()) {
    failures.push(
      `Harness commit mismatch: expected ${compatibility.harnessCommit}, got ${harnessCommit}`,
    );
  }
}

const nodeVersion = process.versions.node;
if (!satisfies(nodeVersion, compatibility.node)) {
  failures.push(`Node ${nodeVersion} does not satisfy ${compatibility.node}`);
}

const pnpmProbe = classifyPnpm(probePnpm({ selection: selectTrustedPnpm(), cwd: repositoryRoot }), compatibility.pnpm);
const pnpmVersion = pnpmProbe.ok ? pnpmProbe.version : null;
if (!pnpmProbe.ok) {
  const messages = {
    missing: "no trusted pnpm installation was found",
    untrusted: "no trusted pnpm entry was found (untrusted candidates were ignored)",
    inaccessible: "the trusted pnpm entry is not readable or executable",
    timeout: "the trusted pnpm version probe timed out",
    nonzero: "the trusted pnpm version probe exited non-zero",
    "invalid-version": "the trusted pnpm version probe returned an invalid version",
    execution: "the trusted pnpm version probe could not be executed",
    "output-limit": "the trusted pnpm version probe exceeded its output limit",
    "version-mismatch": "the trusted pnpm version does not match the pinned requirement",
  };
  failures.push(messages[pnpmProbe.reason] ?? "the trusted pnpm version probe failed");
}

if (failures.length > 0) {
  console.error("Compatibility check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Compatibility check passed (harness ${compatibility.harnessCommit}, Node ${nodeVersion}, pnpm ${pnpmVersion}).`);
}
