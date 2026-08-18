import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compatibilityPath = resolve(repositoryRoot, "compatibility.json");

function parseVersion(value) {
  const match = String(value).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText);
  if (!version) return false;

  return String(rangeText)
    .split("||")
    .map((alternative) => alternative.trim())
    .some((alternative) => {
      if (alternative.startsWith(">=")) {
        const minimum = parseVersion(alternative.slice(2).trim());
        return minimum !== null && compareVersions(version, minimum) >= 0;
      }

      if (alternative.startsWith("^")) {
        const minimum = parseVersion(alternative.slice(1).trim());
        if (!minimum || compareVersions(version, minimum) < 0) return false;
        const upperBound = [minimum[0] + 1, 0, 0];
        return compareVersions(version, upperBound) < 0;
      }

      const exact = parseVersion(alternative);
      return exact !== null && compareVersions(version, exact) === 0;
    });
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
const failures = [];

const harnessPath = resolve(repositoryRoot, compatibility.harnessPath);
if (!existsSync(harnessPath)) {
  failures.push(`Harness directory does not exist: ${harnessPath}`);
} else {
  const harnessCommit = commandOutput("git", ["-C", harnessPath, "rev-parse", "HEAD"]);
  if (!harnessCommit) {
    failures.push(`Unable to read harness HEAD in ${harnessPath}`);
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

const pnpmVersion = commandOutput("pnpm", ["--version"]);
if (!pnpmVersion) {
  failures.push("pnpm is not installed or could not be executed");
} else if (!satisfies(pnpmVersion, compatibility.pnpm)) {
  failures.push(`pnpm ${pnpmVersion} does not satisfy ${compatibility.pnpm}`);
}

if (failures.length > 0) {
  console.error("Compatibility check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Compatibility check passed (harness ${compatibility.harnessCommit}, Node ${nodeVersion}, pnpm ${pnpmVersion}).`);
}
