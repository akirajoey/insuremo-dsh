#!/usr/bin/env node
/**
 * Read-only Windows npx adapter-policy probe for TASK-096.
 *
 * Run on the affected Windows host with:
 *   node scripts/probe-windows-npx.mjs
 *
 * This is a standalone, bounded mirror of the production resolver policy. It
 * is not the Workbench runtime and an exit-0 result is not product-chain
 * verification. It does not install packages or contact a registry. The
 * final native `node npx-cli.js --version` is performed only after the same
 * shim/path checks below pass; it proves this accepted pair starts without
 * cmd.exe splitting a spaced path, not that a Web-installed Workbench flow
 * succeeded.
 */
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_SHIM_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const PROBE_TIMEOUT_MS = 10_000;
const NPX_CLI_PARTS = ["node_modules", "npm", "bin", "npx-cli.js"];
const NPM_PREFIX_PARTS = ["node_modules", "npm", "bin", "npm-prefix.js"];
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/iu;
const DSH_ENV_PREFIX = "DSH_";

// Keep these exact accepted forms in lock-step with parseNpmNpxShim() in
// packages/insuremo-service/src/run.ts. The probe never executes a shim to
// discover which form it is using.
const MODERN_NPX_SHIM_LINES = [
  ":: created by npm, please don't edit manually.",
  "@echo off",
  "setlocal",
  'set "node_exe=%~dp0\\node.exe"',
  'if not exist "%node_exe%" (',
  'set "node_exe=node"',
  ")",
  'set "npm_prefix_js=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'set "npx_cli_js=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'for /f "delims=" %%f in (\'call "%node_exe%" "%npm_prefix_js%"\') do (',
  'set "npm_prefix_npx_cli_js=%%f\\node_modules\\npm\\bin\\npx-cli.js"',
  ")",
  'if exist "%npm_prefix_npx_cli_js%" (',
  'set "npx_cli_js=%npm_prefix_npx_cli_js%"',
  ")",
  '"%node_exe%" "%npx_cli_js%" %*',
];

const LEGACY_NPX_SHIM_LINES = [
  "@echo off",
  "goto start",
  ":find_dp0",
  "set dp0=%~dp0",
  "exit /b",
  ":start",
  "setlocal",
  "call :find_dp0",
  'if exist "%dp0%\\node.exe" (',
  'set "_prog=%dp0%\\node.exe"',
  ") else (",
  'set "_prog=node"',
  "set pathext=%pathext:;.js;=;%",
  ")",
  'endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*',
];

/** Parse only the two npm-generated npx shim forms accepted by production. */
export function parseNpmNpxShim(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_SHIM_BYTES) return undefined;
  const lines = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map(line => line.trim().replace(/[ \t]+/gu, " ").toLowerCase())
    .filter(line => line.length > 0);
  if (sameLines(lines, MODERN_NPX_SHIM_LINES)) return "modern";
  if (sameLines(lines, LEGACY_NPX_SHIM_LINES)) return "legacy";
  return undefined;
}

function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/** Prefix stdout must be exactly one unwrapped absolute Windows path line. */
export function parsePrefixOutput(output) {
  if (typeof output !== "string") return undefined;
  const lines = output.replace(/\r\n?/gu, "\n").split("\n");
  // npm-prefix.js writes one line plus, normally, one terminal newline. Do
  // not silently discard leading or repeated blank lines as arbitrary output.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) return undefined;
  const raw = lines[0];
  const value = raw.trim();
  if (value.length === 0 || raw !== value || /[\p{Cc}"]/u.test(value)) return undefined;
  return win32.isAbsolute(value) ? value : undefined;
}

/** Case-insensitive canonical containment equivalent to production on Win32. */
export function containsCanonicalWindows(root, candidate) {
  if (typeof root !== "string" || typeof candidate !== "string") return false;
  const relativePath = win32.relative(root.toLowerCase(), candidate.toLowerCase());
  return relativePath.length > 0
    && relativePath !== ".."
    && !relativePath.startsWith(`..${win32.sep}`)
    && !win32.isAbsolute(relativePath);
}

/** The runtime fallback is accepted only when its canonical basename is node.exe. */
export function isNodeExecutable(path) {
  return typeof path === "string" && win32.basename(path).toLowerCase() === "node.exe";
}

function safeEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value;
  }
  return env;
}

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("probe deadline exceeded");
  return Math.max(1, value);
}

function missingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function withDeadline(promise, deadline, message = "probe subprocess timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), remaining(deadline));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutError(error) {
  return error?.code === "ETIMEDOUT" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

async function boundedText(path, deadline) {
  const file = await withDeadline(open(path, "r"), deadline);
  try {
    const bytes = Buffer.alloc(MAX_SHIM_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await withDeadline(file.read(bytes, offset, bytes.length - offset, offset), deadline);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_SHIM_BYTES) throw new Error("npx shim exceeds the 16 KiB bound");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    try {
      await file.close();
    } catch {
      // Keep the probe's failure boundary fixed and redacted.
    }
  }
}

async function regularFile(path, root, deadline, executable = false) {
  const canonical = await withDeadline(realpath(path), deadline);
  if (root !== undefined && !containsCanonicalWindows(root, canonical)) throw new Error("path outside accepted root");
  const info = await withDeadline(stat(canonical), deadline);
  if (!info.isFile()) throw new Error("accepted path is not a regular file");
  await withDeadline(access(canonical, constants.R_OK), deadline);
  if (executable) await withDeadline(access(canonical, constants.X_OK), deadline);
  return canonical;
}

async function optionalRegularFile(path, root, deadline, executable = false) {
  try {
    return await regularFile(path, root, deadline, executable);
  } catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
}

async function canonicalDirectory(path, deadline) {
  try {
    const canonical = await withDeadline(realpath(path), deadline);
    const info = await withDeadline(stat(canonical), deadline);
    return info.isDirectory() ? canonical : undefined;
  } catch (error) {
    if (missingPath(error)) return undefined;
    throw error;
  }
}

function where(command, deadline, env) {
  let result;
  try {
    result = spawnSync("where.exe", [command], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: remaining(deadline),
    });
  } catch (error) {
    if (timeoutError(error)) throw new Error("probe subprocess timed out");
    return undefined;
  }
  if (result.error !== undefined) {
    if (timeoutError(result.error)) throw new Error("probe subprocess timed out");
    return undefined;
  }
  if (result.status !== 0 || result.signal !== null) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .map(value => value.trim())
    .find(value => value.length > 0);
}

function runPrefixHelper(node, prefixScript, deadline, env) {
  let result;
  try {
    result = spawnSync(node, [prefixScript], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: remaining(deadline),
    });
  } catch (error) {
    if (timeoutError(error)) throw new Error("prefix probe timed out");
    return undefined;
  }
  if (result.error !== undefined) {
    if (timeoutError(result.error)) throw new Error("prefix probe timed out");
    return undefined;
  }
  if (result.status !== 0 || result.signal !== null) return undefined;
  return result.stdout;
}

function terminateChild(child) {
  try {
    child.kill();
  } catch {
    // close/exit will report the bounded failure below.
  }
}

function runNativeVersion(node, cli, deadline, env) {
  return new Promise((resolveResult, rejectResult) => {
    const timeoutMs = remaining(deadline);
    let child;
    try {
      child = spawn(node, [cli, "--version"], {
        cwd: process.cwd(),
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectResult(new Error("native npx process could not be started"));
      return;
    }

    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);
    timer.unref?.();

    const onOutput = chunk => {
      outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (outputBytes > MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        terminateChild(child);
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectResult(error);
      else resolveResult(result);
    };
    child.once("error", () => settle(new Error("native npx process failed")));
    child.once("close", (code, signal) => {
      if (timedOut) return settle(new Error("native npx process timed out"));
      if (outputExceeded) return settle(new Error("native npx output exceeded the 64 KiB bound"));
      if (code !== 0 || signal !== null) return settle(new Error("native npx version probe failed"));
      settle(undefined, outputBytes);
    });
  });
}

/**
 * Run the standalone equivalent policy probe. Return codes are intentionally
 * distinct: 0 = policy checks and native version start succeeded, 1 = fail,
 * 2 = this host is not Windows and therefore is unverified.
 */
export async function runProbe() {
  if (process.platform !== "win32") {
    console.error("TASK-096 Windows probe: unverified (this host is not Windows)");
    return 2;
  }

  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  const env = safeEnvironment();
  try {
    const shimCandidate = where("npx.cmd", deadline, env) ?? where("npx.bat", deadline, env);
    if (shimCandidate === undefined) throw new Error("npx shim was not found by where.exe");
    const shim = await regularFile(shimCandidate, undefined, deadline, true);
    const shimFormat = parseNpmNpxShim(await boundedText(shim, deadline));
    if (shimFormat === undefined) throw new Error("npx shim is not a standard npm shim");

    const shimDir = dirname(shim);
    const siblingCli = await optionalRegularFile(join(shimDir, ...NPX_CLI_PARTS), shimDir, deadline);
    const prefixScript = shimFormat === "modern"
      ? await optionalRegularFile(join(shimDir, ...NPM_PREFIX_PARTS), shimDir, deadline)
      : undefined;

    let node = await optionalRegularFile(join(shimDir, "node.exe"), shimDir, deadline, true);
    if (node === undefined) {
      const nodeCandidate = where("node.exe", deadline, env) ?? where("node", deadline, env);
      if (nodeCandidate === undefined) throw new Error("node.exe was not found beside npx shim or on PATH");
      if (!isNodeExecutable(nodeCandidate)) throw new Error("PATH node candidate is not node.exe");
      node = await regularFile(nodeCandidate, undefined, deadline, true);
      if (!isNodeExecutable(node)) throw new Error("canonical PATH node is not node.exe");
    }

    let cli = siblingCli;
    if (prefixScript !== undefined) {
      const prefixOutput = runPrefixHelper(node, prefixScript, deadline, env);
      const prefixText = prefixOutput === undefined ? undefined : parsePrefixOutput(prefixOutput);
      if (prefixText !== undefined) {
        const prefixDir = await canonicalDirectory(prefixText, deadline);
        if (prefixDir !== undefined) {
          // A relocated CLI is accepted only after canonical containment under
          // the prefix returned by the verified npm helper. Missing means the
          // standard shim fallback; escape/unreadable errors fail closed.
          const relocated = await optionalRegularFile(join(prefixDir, ...NPX_CLI_PARTS), prefixDir, deadline);
          if (relocated !== undefined) cli = relocated;
        }
      }
    }
    if (cli === undefined) throw new Error("accepted npm npx CLI was not found");

    console.log(`shim=validated (${shimFormat} npm form)`);
    console.log("node=validated canonical node.exe");
    console.log("cli=validated canonical npm npx-cli.js containment");
    console.log("probe=native argv [node.exe, npx-cli.js, --version], shell=false, bounded");
    await runNativeVersion(node, cli, deadline, env);
    console.log("TASK-096 Windows probe: SHIM-CHECK-PASS (not Web product-chain verification)");
    return 0;
  } catch (error) {
    if (error?.message === "probe deadline exceeded" || error?.message?.includes("timed out")) {
      console.error("TASK-096 Windows probe: FAIL: bounded probe timed out");
    } else {
      console.error("TASK-096 Windows probe: FAIL: standard npx shim/pair checks failed");
    }
    return 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invokedPath !== undefined && invokedPath.toLowerCase() === modulePath.toLowerCase()) {
  runProbe().then(code => { process.exitCode = code; }).catch(() => {
    console.error("TASK-096 Windows probe: FAIL: bounded probe failed");
    process.exitCode = 1;
  });
}
