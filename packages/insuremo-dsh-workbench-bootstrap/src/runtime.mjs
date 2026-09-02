import { createRequire } from "node:module";
import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathExists } from "./paths.mjs";

const require = createRequire(import.meta.url);

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 };

/** Conventional exit codes: a signaled child never maps to success. */
export function exitCodeForClose(code, signal) {
  if (signal !== null && signal !== undefined) return 128 + (SIGNAL_NUMBERS[signal] ?? 15);
  return code ?? 1;
}

export function resolveRuntime(runtimeRoot) {
  const dshRequire = runtimeRoot === undefined ? undefined : createRequire(join(runtimeRoot, "package.json"));
  const dshBin = dshRequire?.resolve("@deepseek-ai/dsh/lib/bin.js");
  const pnpmPackage = dirname(require.resolve("pnpm"));
  const pnpmMjs = join(pnpmPackage, "bin", "pnpm.mjs");
  const dshPackage = dshRequire === undefined ? undefined : dirname(dshRequire.resolve("@deepseek-ai/dsh/package.json"));
  return { dshBin, pnpmMjs, dshPackage, pnpmPackage };
}

export function runtimeEnv(dshHome, shimDir, storeDir) {
  const appHome = join(dshHome, "insuremo-dsh");
  const path = shimDir === undefined
    ? process.env.PATH ?? ""
    : `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  return {
    ...process.env,
    DSH_HOME: dshHome,
    PNPM_HOME: join(appHome, "pnpm-home"),
    COREPACK_HOME: join(appHome, "corepack-home"),
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    npm_config_store_dir: storeDir ?? join(appHome, "pnpm-store"),
    PATH: path,
  };
}

export async function createPnpmShim(root) {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const runtime = resolveRuntime();
  const node = process.execPath;
  const posix = `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(runtime.pnpmMjs)} "$@"\n`;
  const windows = `@echo off\r\n"${node.replaceAll("\"", "\"\"")}" "${runtime.pnpmMjs.replaceAll("\"", "\"\"")}" %*\r\n`;
  await writeFile(join(binDir, "pnpm"), posix, { mode: 0o755 });
  await writeFile(join(binDir, "pnpm.cmd"), windows);
  await writeFile(join(binDir, "pnpx"), posix);
  await writeFile(join(binDir, "pnpx.cmd"), windows);
  await chmod(join(binDir, "pnpm"), 0o755);
  await chmod(join(binDir, "pnpx"), 0o755);
  return binDir;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandResult(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (options.capture !== false) {
      child.stdout?.on("data", chunk => { stdout += String(chunk); });
      child.stderr?.on("data", chunk => { stderr += String(chunk); });
    }
    let timer;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`command timed out after ${options.timeoutMs}ms: ${file}`));
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.once("error", error => {
      if (timer !== undefined) clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

export async function runPnpm(runtimeRoot, dshHome, args, operationRoot, storeDir) {
  const shim = await createPnpmShim(operationRoot);
  const env = runtimeEnv(dshHome, shim, storeDir);
  const runtime = resolveRuntime();
  return commandResult(process.execPath, [runtime.pnpmMjs, ...args], {
    cwd: runtimeRoot,
    env,
    timeoutMs: 30 * 60 * 1000,
  });
}

export async function installRuntime({ packageRoot, operationRoot, dshHome, manifest, storeDir }) {
  const runtimeRoot = join(operationRoot, "runtime");
  const payloadRoot = join(operationRoot, "payload");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(payloadRoot, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    await cp(join(packageRoot, "runtime", file), join(runtimeRoot, file));
  }
  const payloadPath = join(payloadRoot, "icomposer-workbench.tgz");
  await cp(join(packageRoot, manifest.workbench.payloadFile), payloadPath);
  const installed = await runPnpm(runtimeRoot, dshHome, ["install", "--frozen-lockfile", "--ignore-scripts"], operationRoot, storeDir);
  if (installed.code !== 0) throw new Error(`runtime installation failed (${installed.code}): ${`${installed.stdout}\n${installed.stderr}`.slice(-4000)}`);
  await mkdir(storeDir, { recursive: true });
  await assertRuntimeIdentity(runtimeRoot, manifest);
  await prepareNativeRuntime(runtimeRoot, dshHome, operationRoot, storeDir, manifest.runtime);
  return { runtimeRoot, payloadPath };
}

export async function assertRuntimeIdentity(runtimeRoot, manifest) {
  const runtime = resolveRuntime(runtimeRoot);
  const dshManifest = JSON.parse(await readFile(join(runtime.dshPackage, "package.json"), "utf8"));
  const pnpmManifest = JSON.parse(await readFile(join(runtime.pnpmPackage, "package.json"), "utf8"));
  const vendorRoot = join(runtime.dshPackage, "..");
  const baseManifest = JSON.parse(await readFile(join(vendorRoot, "dsh-base", "package.json"), "utf8"));
  const webManifest = JSON.parse(await readFile(join(vendorRoot, "dsh-web-app", "package.json"), "utf8"));
  if (dshManifest.version !== manifest.runtime.dsh.version) throw new Error(`installed dsh is ${dshManifest.version}, expected ${manifest.runtime.dsh.version}`);
  if (pnpmManifest.version !== manifest.runtime.pnpm.version) throw new Error(`installed pnpm is ${pnpmManifest.version}, expected ${manifest.runtime.pnpm.version}`);
  if (baseManifest.version !== manifest.runtime.base.version) throw new Error(`installed dsh-base is ${baseManifest.version}, expected ${manifest.runtime.base.version}`);
  if (webManifest.version !== manifest.runtime.webApp.version) throw new Error(`installed dsh-web-app is ${webManifest.version}, expected ${manifest.runtime.webApp.version}`);
  return runtime;
}

/** Scans the hoisted runtime closure for @deepseek-ai/dsh* packages: { name: version }. */
export async function scanInstalledDshGraph(runtimeRoot) {
  const found = {};
  await walkNodeModules(join(runtimeRoot, "node_modules"), found);
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

async function walkNodeModules(nodeModules, found) {
  if (!(await pathExists(nodeModules))) return;
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || !entry.isDirectory()) continue;
    const full = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      await walkScoped(full, found);
      continue;
    }
    await recordDshPackage(full, found);
    await walkNodeModules(join(full, "node_modules"), found);
  }
}

async function walkScoped(scopeDir, found) {
  for (const entry of await readdir(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await recordDshPackage(join(scopeDir, entry.name), found);
    await walkNodeModules(join(scopeDir, entry.name, "node_modules"), found);
  }
}

async function recordDshPackage(packageDir, found) {
  const manifestPath = join(packageDir, "package.json");
  if (!(await pathExists(manifestPath))) return;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name === "string" && (manifest.name === "@deepseek-ai/dsh" || manifest.name.startsWith("@deepseek-ai/dsh-"))) {
    found[manifest.name] = manifest.version;
  }
}

async function prepareNativeRuntime(runtimeRoot, dshHome, operationRoot, storeDir, runtimeManifest) {
  const shim = await createPnpmShim(operationRoot);
  const env = runtimeEnv(dshHome, shim, storeDir);
  const helper = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh-subprocess-local", "scripts", "ensure-spawn-helper.mjs");
  if (await pathExists(helper)) {
    const result = await commandResult(process.execPath, [helper], { cwd: runtimeRoot, env, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`controlled spawn-helper preparation failed (${result.code})`);
  }
  const probe = await commandResult(process.execPath, ["--input-type=module", "-e", "import { createRequire } from 'node:module'; const r=createRequire(process.cwd()+'/package.json'); r('node-pty'); r('koffi');"], { cwd: runtimeRoot, env, timeoutMs: 60_000 });
  if (probe.code === 0) return;
  const rebuild = runtimeManifest.rebuildPackages ?? ["node-pty", "koffi"];
  if (!Array.isArray(rebuild) || rebuild.some(name => !["node-pty", "koffi"].includes(name))) throw new Error("native probe failed and rebuild package is outside the allowlist");
  const rebuilt = await runPnpm(runtimeRoot, dshHome, ["rebuild", ...rebuild], operationRoot, storeDir);
  if (rebuilt.code !== 0) throw new Error(`controlled native rebuild failed (${rebuilt.code}): ${rebuilt.stderr.slice(-2000)}`);
  const checked = await commandResult(process.execPath, ["--input-type=module", "-e", "import { createRequire } from 'node:module'; const r=createRequire(process.cwd()+'/package.json'); r('node-pty'); r('koffi');"], { cwd: runtimeRoot, env, timeoutMs: 60_000 });
  if (checked.code !== 0) throw new Error(`native runtime probe failed after controlled rebuild: ${checked.stderr.slice(-2000)}`);
}

export async function runPluginCommand(dshHome, profileName, args, operationRoot, runtimeRoot, storeDir) {
  const shim = await createPnpmShim(operationRoot);
  const env = runtimeEnv(dshHome, shim, storeDir);
  const runtime = resolveRuntime(runtimeRoot);
  const result = await commandResult(process.execPath, [
    runtime.dshBin,
    "plugin",
    "--profile",
    profileName,
    ...args,
  ], { cwd: dshHome, env, timeoutMs: 15 * 60 * 1000 });
  if (result.code !== 0) {
    throw new Error(`profile dependency operation failed (${result.code}): ${`${result.stdout}\n${result.stderr}`.slice(-4000)}`);
  }
  return result;
}

export async function runPluginAdd(dshHome, profileName, webAppVersion, payloadPath, operationRoot, runtimeRoot, storeDir) {
  return runPluginCommand(dshHome, profileName, [
    "add",
    "--save-exact",
    "--ignore-scripts",
    `@deepseek-ai/dsh-web-app@${webAppVersion}`,
    payloadPath,
  ], operationRoot, runtimeRoot, storeDir);
}

export async function launchWorkbench(dshHome, profileName, runtimeRoot, args = []) {
  const runtime = resolveRuntime(runtimeRoot);
  const env = runtimeEnv(dshHome);
  const child = spawn(process.execPath, [runtime.dshBin, "--profile", profileName, ...args], {
    cwd: dshHome,
    env,
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  return new Promise(resolvePromise => {
    const forward = signal => { if (child.exitCode === null) child.kill(signal); };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      resolvePromise(exitCodeForClose(code, signal));
    });
    child.once("error", error => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      process.stderr.write(`insuremo-dsh: failed to launch the runtime: ${error.message}\n`);
      resolvePromise(1);
    });
  });
}

export async function bootSmoke(dshHome, profileName, runtimeRoot, timeoutMs = 90_000) {
  const runtime = resolveRuntime(runtimeRoot);
  const child = spawn(process.execPath, [runtime.dshBin, "--profile", profileName], {
    cwd: dshHome,
    env: runtimeEnv(dshHome),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let output = "";
  let settled = false;
  let closed = false;
  let closeResolve;
  const closePromise = new Promise(resolvePromise => { closeResolve = resolvePromise; });
  child.once("close", (code, signal) => {
    closed = true;
    closeResolve({ code, signal });
  });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const stop = async (error, value, signal = "SIGTERM") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!closed) {
        child.kill(signal);
        await closePromise;
      }
      if (error === undefined) resolvePromise(value);
      else rejectPromise(error);
    };
    const timer = setTimeout(() => {
      void stop(new Error(`profile boot timed out: ${output.slice(-2500)}`), undefined, "SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const onData = chunk => {
      output += String(chunk);
      if (/ERR_MODULE_NOT_FOUND|loader failed|plugin .* failed to load/i.test(output)) {
        void stop(new Error(`profile boot failed: ${output.slice(-3000)}`), undefined, "SIGKILL");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const poll = async () => {
      if (settled) return;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match === null) {
        setTimeout(() => void poll(), 100);
        return;
      }
      const port = Number(match[1]);
      const deadline = Date.now() + 20_000;
      while (!settled && Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/icomposer-workbench/insuremo/overview`, { headers: { Accept: "application/json" } });
          if (response.status === 200) {
            await stop(undefined, { port, output });
            return;
          }
          if (response.status === 404) {
            await stop(new Error(`profile boot overview route returned 404: ${output.slice(-2500)}`), undefined, "SIGKILL");
            return;
          }
        } catch {
          // The web server may print its URL before the route is mounted.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      }
      if (!settled) await stop(new Error(`profile overview route timed out: ${output.slice(-2500)}`), undefined, "SIGKILL");
    };
    child.once("error", error => { void stop(error, undefined, "SIGKILL"); });
    child.once("close", (code, signal) => {
      if (!settled && code !== 0) void stop(new Error(`profile exited before smoke completed (${code ?? signal}): ${output.slice(-2500)}`), undefined, "SIGKILL");
    });
    void poll();
  });
  return result;
}
