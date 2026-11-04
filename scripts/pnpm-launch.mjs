/**
 * Fail-closed pnpm --version launch without a shell.
 *
 * Candidates come from `npm_execpath` and PATH. A JavaScript candidate is
 * accepted only when its nearest package.json identifies it as pnpm and
 * declares exactly that bin; a native candidate must be named pnpm(.exe) and
 * be executable. This is identity checking of the invoked entry, not binary
 * attestation: it does not prove the installation is trusted, and it does not
 * restrict normal user prefixes, Corepack or version managers. No candidate
 * is ever run as a shell script or through a command string.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, resolve, win32 } from "node:path";

export const PNPM_TIMEOUT_MS = 5000;
export const PNPM_MAX_OUTPUT = 16 * 1024;
const JS_NAMES = new Set(["pnpm.mjs", "pnpm.cjs", "pnpm.js"]);
const SHELL_SUFFIXES = new Set([".cmd", ".bat", ".ps1", ".sh"]);

function pathApi(platform) { return platform === "win32" ? win32 : posix; }
function isMissing(error) { return error?.code === "ENOENT" || error?.code === "ENOTDIR"; }

function parseVersion(value) {
  const match = String(value).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Existing compatibility.json range semantics, shared by Node and pnpm. */
export function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText);
  if (!version) return false;
  return String(rangeText).split("||").map(alternative => alternative.trim()).some(alternative => {
    if (alternative.startsWith(">=")) {
      const minimum = parseVersion(alternative.slice(2).trim());
      return minimum !== null && compareVersions(version, minimum) >= 0;
    }
    if (alternative.startsWith("^")) {
      const minimum = parseVersion(alternative.slice(1).trim());
      if (!minimum || compareVersions(version, minimum) < 0) return false;
      return compareVersions(version, [minimum[0] + 1, 0, 0]) < 0;
    }
    const exact = parseVersion(alternative);
    return exact !== null && compareVersions(version, exact) === 0;
  });
}

/** Retain a distinct version-mismatch outcome after a successful launch. */
export function classifyPnpm(probe, range) {
  if (!probe.ok) return probe;
  return satisfies(probe.version, range) ? probe : { ok: false, reason: "version-mismatch", version: probe.version };
}

/** Fixed argument vector; shell launchers are rejected on every platform. */
export function makePnpmPlan(candidate, { platform = process.platform, nodePath = process.execPath } = {}) {
  const path = pathApi(platform);
  if (!candidate || !path.isAbsolute(candidate.path) || !path.isAbsolute(nodePath)) return null;
  if (SHELL_SUFFIXES.has(path.extname(candidate.path).toLowerCase())) return null;
  if (candidate.kind === "js") {
    if (!JS_NAMES.has(path.basename(candidate.path).toLowerCase())) return null;
    return { command: nodePath, args: [candidate.path, "--version"], shell: false };
  }
  if (candidate.kind === "native") {
    const expected = platform === "win32" ? "pnpm.exe" : "pnpm";
    if (path.basename(candidate.path).toLowerCase() !== expected) return null;
    return { command: candidate.path, args: ["--version"], shell: false };
  }
  return null;
}

/** Find the nearest package.json and require that it names pnpm and declares this bin. */
function isDeclaredPnpmJs(canonical, io, platform) {
  const path = pathApi(platform);
  let directory = path.dirname(canonical);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const info = io.statSync(manifestPath);
      if (!info.isFile() || info.size > 64 * 1024) return false;
      const manifest = JSON.parse(io.readFileSync(manifestPath, "utf8"));
      const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pnpm;
      if (manifest.name !== "pnpm" || typeof declared !== "string") return false;
      return path.resolve(directory, declared) === canonical;
    } catch (error) {
      if (!isMissing(error)) return false;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return false;
}

/**
 * Select without launching. Optional io is for controlled unit fixtures only;
 * production never takes an identity or trust anchor from the environment.
 */
export function selectTrustedPnpm({
  platform = process.platform,
  nodePath = process.execPath,
  env = process.env,
  io = fs,
} = {}) {
  const path = pathApi(platform);
  const candidates = [];
  if (typeof env.npm_execpath === "string") candidates.push(env.npm_execpath);
  const pathSeparator = platform === "win32" ? ";" : ":";
  for (const entry of String(env.PATH ?? env.Path ?? "").split(pathSeparator)) {
    if (!path.isAbsolute(entry)) continue;
    candidates.push(path.join(entry, platform === "win32" ? "pnpm.exe" : "pnpm"));
  }
  let sawUntrusted = false;
  let sawInaccessible = false;
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) { sawUntrusted = true; continue; }
    if (SHELL_SUFFIXES.has(path.extname(candidate).toLowerCase())) { sawUntrusted = true; continue; }
    let canonical;
    try { canonical = io.realpathSync(candidate); }
    catch (error) {
      if (!isMissing(error)) sawInaccessible = true;
      continue;
    }
    const dedupe = platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    try {
      if (!io.statSync(canonical).isFile()) { sawUntrusted = true; continue; }
      const name = path.basename(canonical);
      const kind = JS_NAMES.has(name.toLowerCase()) ? "js" : name.toLowerCase() === (platform === "win32" ? "pnpm.exe" : "pnpm") ? "native" : null;
      if (kind === null) { sawUntrusted = true; continue; }
      if (kind === "js") {
        io.accessSync(canonical, fs.constants.R_OK);
        if (!isDeclaredPnpmJs(canonical, io, platform)) { sawUntrusted = true; continue; }
      } else {
        io.accessSync(canonical, fs.constants.R_OK | (platform === "win32" ? 0 : fs.constants.X_OK));
      }
      const plan = makePnpmPlan({ kind, path: canonical }, { platform, nodePath });
      if (plan !== null) return { ok: true, plan, kind };
      sawUntrusted = true;
    } catch (error) {
      if (isMissing(error)) sawUntrusted = true;
      else sawInaccessible = true;
    }
  }
  return { ok: false, reason: sawInaccessible ? "inaccessible" : sawUntrusted ? "untrusted" : "missing" };
}

function launchErrorReason(error) {
  if (error?.code === "ETIMEDOUT") return "timeout";
  if (["EACCES", "EPERM"].includes(error?.code)) return "inaccessible";
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) return "missing";
  if (["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(error?.code)) return "output-limit";
  return "execution";
}

/** Run precisely one accepted plan. Never expose child stdout/stderr on failure. */
export function probePnpm({ selection, spawn = spawnSync, cwd, env = process.env, timeout = PNPM_TIMEOUT_MS } = {}) {
  if (!selection?.ok) return { ok: false, reason: selection?.reason ?? "missing" };
  const { plan } = selection;
  const childEnv = {};
  for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (typeof env[key] === "string") childEnv[key] = env[key];
  }
  let result;
  try {
    result = spawn(plan.command, plan.args, {
      cwd, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      shell: false, windowsHide: true, timeout, maxBuffer: PNPM_MAX_OUTPUT,
    });
  } catch (error) {
    return { ok: false, reason: launchErrorReason(error) };
  }
  if (result.error) return { ok: false, reason: launchErrorReason(result.error) };
  if (result.status !== 0) return { ok: false, reason: "nonzero" };
  const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return { ok: false, reason: "invalid-version" };
  return { ok: true, version, kind: selection.kind };
}
