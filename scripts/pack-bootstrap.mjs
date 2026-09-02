#!/usr/bin/env node
/** Build one public npm bootstrap artifact without publishing it. */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { join, relative, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertManifestDshGraph, describeWorkbenchPayload, readChannelConfig } from "../packages/insuremo-dsh-workbench-bootstrap/src/channel.mjs";
import { fileSha256, treeSha256 } from "../packages/insuremo-dsh-workbench-bootstrap/src/paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "packages", "insuremo-dsh-workbench-bootstrap");
const pluginDir = join(root, "git-dist", "icomposer-workbench");
const releaseDir = join(root, "dist-release");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const lifecycleNames = new Set(["preinstall", "install", "postinstall", "prepare"]);
const knownPeerOverrides = {
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/cordis-plugin-group": "1.0.1",
  "@deepseek-ai/cordis-plugin-hmr": "1.0.16",
  "@deepseek-ai/cordis-plugin-include": "1.0.6",
  "@deepseek-ai/cordis-plugin-loader": "1.0.2",
  "@deepseek-ai/cordis-plugin-timer": "1.1.3",
  "@deepseek-ai/schemastery": "3.18.1",
  react: "18.3.1",
  "react-dom": "18.3.1",
  zod: "4.4.3",
};

function runNpm(args, cwd) {
  return execFileSync(npmCommand, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function runPnpm(args, cwd) {
  return execFileSync(pnpmCommand, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function packageManifests(nodeModules, output = []) {
  if (!(await exists(nodeModules))) return output;
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const full = join(nodeModules, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await packageManifests(full, output);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const manifestPath = join(full, "package.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    output.push({ path: manifestPath, manifest });
    await packageManifests(join(full, "node_modules"), output);
  }
  return output;
}

function lifecycleReport(items) {
  return items.flatMap(item => {
    const hooks = Object.keys(item.manifest.scripts ?? {}).filter(name => lifecycleNames.has(name));
    if (hooks.length === 0) return [];
    const native = ["node-pty", "koffi"].includes(item.manifest.name);
    const helper = item.manifest.name === "@deepseek-ai/dsh-subprocess-local";
    return [{
      package: item.manifest.name,
      version: item.manifest.version,
      hooks,
      action: native ? "probe-then-rebuild-allowlist" : helper ? "run-fixed-helper-only" : "never-run",
    }];
  });
}

function lockRecords(lock) {
  return Object.entries(lock.packages ?? {}).map(([key, value]) => ({ key, value })).filter(item => item.key !== "").sort((a, b) => a.key.localeCompare(b.key));
}

function lockIntegrity(lock, packageName, version) {
  const record = lockRecords(lock).find(item => item.key === `${packageName}@${version}`
    || item.key.startsWith(`${packageName}@${version}_`)
    || item.key.startsWith(`/${packageName}@${version}`));
  return record?.value?.resolution?.integrity;
}

function npmView(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(npmCommand, ["view", ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error != null) {
        error.message = `npm view ${args.join(" ")} failed: ${String(stderr ?? "").trim() || error.message}`;
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function auditExactDshGraph(packages, version) {
  const missing = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < packages.length) {
      const name = packages[cursor];
      cursor += 1;
      try {
        const output = await npmView([`${name}@${version}`, "version"]);
        if (output.trim() !== version) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, packages.length) }, worker));
  if (missing.length > 0) {
    throw new Error(`exact DSH graph audit failed; ${version} is not published for: ${missing.join(", ")}`);
  }
}

async function verifyRuntime(runtimeRoot, input) {
  const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  const expected = {
    "@deepseek-ai/dsh": input.dshVersion,
    "@deepseek-ai/dsh-base": input.dshVersion,
    "@deepseek-ai/dsh-web-app": input.dshVersion,
  };
  for (const [name, version] of Object.entries(expected)) {
    const packagePath = join(runtimeRoot, "node_modules", ...name.split("/"), "package.json");
    const installed = JSON.parse(await readFile(packagePath, "utf8"));
    if (installed.version !== version) throw new Error(`runtime ${name} is ${installed.version}, expected ${version}`);
  }
  if (runtimeManifest.dependencies["@icomposer/workbench"] !== "file:../payload/icomposer-workbench.tgz") throw new Error("runtime Workbench dependency is not the controlled embedded payload");
  const lock = parseYaml((await readFile(join(runtimeRoot, "pnpm-lock.yaml"))).toString("utf8"));
  if (String(lock.lockfileVersion) !== "9.0") throw new Error(`unsupported pnpm lockfile ${lock.lockfileVersion}`);
  const importer = lock.importers?.["."];
  if (importer === undefined) throw new Error("runtime pnpm lock importer is missing");
  for (const [name, version] of Object.entries(expected)) {
    const value = importer.dependencies?.[name];
    if (value?.specifier !== version || !String(value.version).startsWith(version)) throw new Error(`runtime lock does not pin ${name}@${version}`);
  }
  const packages = await packageManifests(join(runtimeRoot, "node_modules"));
  const hooks = lifecycleReport(packages);
  const dshPackages = Object.fromEntries(packages.filter(item => item.manifest.name === "@deepseek-ai/dsh" || item.manifest.name?.startsWith("@deepseek-ai/dsh-")).map(item => [item.manifest.name, item.manifest.version]).sort(([a], [b]) => a.localeCompare(b)));
  const workspace = parseYaml((await readFile(join(runtimeRoot, "pnpm-workspace.yaml"))).toString("utf8"));
  const overrides = workspace?.overrides ?? {};
  for (const name of input.dshGraphPackages) {
    if (overrides[name] !== input.dshVersion) throw new Error(`runtime workspace override pins ${name} to ${JSON.stringify(overrides[name])}, expected exact ${input.dshVersion}`);
  }
  assertManifestDshGraph(input, { dshPackages });
  for (const item of lockRecords(lock)) {
    if (item.key.startsWith("file:")) continue;
    if (item.value?.resolution?.integrity === undefined) throw new Error(`runtime lock package lacks integrity: ${item.key}`);
  }
  return {
    lockfileVersion: String(lock.lockfileVersion),
    lockSha256: await fileSha256(join(runtimeRoot, "pnpm-lock.yaml")),
    packageCount: packages.length,
    lifecycleHooks: hooks,
    dshPackages,
    dshIntegrity: lockIntegrity(lock, "@deepseek-ai/dsh", input.dshVersion),
    baseIntegrity: lockIntegrity(lock, "@deepseek-ai/dsh-base", input.dshVersion),
    webAppIntegrity: lockIntegrity(lock, "@deepseek-ai/dsh-web-app", input.dshVersion),
  };
}

async function assertRootSafe(stage) {
  const manifest = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
  if (manifest.private !== undefined || manifest.scripts !== undefined || manifest.devDependencies !== undefined) throw new Error("bootstrap shipped manifest has forbidden fields");
  if (Object.values(manifest.dependencies ?? {}).some(value => /^(?:file|link|workspace):/u.test(String(value)))) throw new Error("bootstrap root has a local dependency");
  if (Object.keys(manifest.dependencies ?? {}).length !== 1 || manifest.dependencies.pnpm === undefined) {
    throw new Error("pnpm is not the sole bundled bootstrap dependency");
  }
  if (manifest.bundleDependencies?.includes("pnpm") !== true) throw new Error("pnpm is not bundled via bundleDependencies");
  const textFiles = ["package.json", "npm-shrinkwrap.json", "channel-manifest.json", "README.md"];
  for (const file of textFiles) {
    const text = await readFile(join(stage, file), "utf8");
    if (/\/Users\/|\/opt\/homebrew|[A-Z]:[\\/]+Users[\\/]/u.test(text)) throw new Error(`host path in shipped ${file}`);
  }
  const rootHooks = Object.keys(manifest.scripts ?? {}).filter(name => lifecycleNames.has(name));
  if (rootHooks.length > 0) throw new Error(`bootstrap root lifecycle hooks: ${rootHooks.join(",")}`);
}

/** Fails closed unless the local git-dist payload is byte-identical to the pinned source commit (whose tree root IS the payload). */
async function verifyPluginProvenance(input) {
  const commit = input.workbenchSourceCommit;
  try {
    runGit(["cat-file", "-e", `${commit}^{commit}`], root);
  } catch {
    throw new Error(`provenance: pinned commit ${commit} does not exist in this repository`);
  }
  const workDir = join(releaseDir, `.provenance-${process.pid}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  try {
    const archivePath = join(workDir, "archive.tar");
    const archiveBytes = execFileSync("git", ["archive", "--format=tar", commit], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    await writeFile(archivePath, archiveBytes);
    const extractDir = join(workDir, "out");
    await mkdir(extractDir, { recursive: true });
    execFileSync("tar", ["-xf", archivePath, "-C", extractDir], { stdio: "ignore", windowsHide: true });
    const [archivedTree, localTree] = [await treeSha256(extractDir), await treeSha256(pluginDir)];
    if (archivedTree !== localTree) {
      throw new Error(`provenance: git-dist payload does not match pinned commit ${commit}; refresh git-dist and update the pin`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function packPlugin(stage, input) {
  if (!(await exists(pluginDir))) throw new Error("git-dist/icomposer-workbench is missing; refresh it first");
  await verifyPluginProvenance(input);
  const payloadDir = join(stage, "payload");
  await mkdir(payloadDir, { recursive: true });
  runNpm(["pack", "--ignore-scripts", "--silent", "--pack-destination", payloadDir], pluginDir);
  const candidates = (await readdir(payloadDir)).filter(name => name.endsWith(".tgz"));
  if (candidates.length !== 1) throw new Error(`expected one Workbench payload tarball, got ${candidates.join(", ")}`);
  const source = join(payloadDir, candidates[0]);
  const destination = join(payloadDir, "icomposer-workbench.tgz");
  if (source !== destination) await rename(source, destination);
  const packageManifest = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  const payload = await describeWorkbenchPayload(pluginDir, { workbenchVersion: packageManifest.version, workbenchSourceCommit: input.workbenchSourceCommit });
  return { path: destination, tgzSha256: await fileSha256(destination), treeSha256: payload.treeSha256, packageName: packageManifest.name, version: packageManifest.version, sourceCommit: input.workbenchSourceCommit };
}

async function packChannel(channel) {
  const input = await readChannelConfig(root, channel);
  const stage = join(releaseDir, `.bootstrap-stage-${channel}-${process.pid}-${Date.now()}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    await cp(join(sourceDir, "src"), join(stage, "lib"), { recursive: true });
    await cp(join(sourceDir, "README.md"), join(stage, "README.md"));
    const plugin = await packPlugin(stage, input);
    if (plugin.version !== input.workbenchVersion) throw new Error(`${channel}: Workbench version mismatch`);
    const rootManifest = {
      name: "insuremo-dsh-workbench",
      version: input.bootstrapVersion,
      description: "Zero-configuration npm launcher for the iComposer Workbench",
      type: "module",
      engines: { node: ">=22.19.0" },
      bin: { "insuremo-dsh": "lib/cli.mjs" },
      files: ["lib", "payload", "runtime", "channel-manifest.json", "README.md"],
      dependencies: { pnpm: input.pnpmVersion },
      bundleDependencies: ["pnpm"],
    };
    await writeFile(join(stage, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
    runNpm(["install", "--ignore-scripts", "--package-lock-only", "--no-audit", "--no-fund", "--prefix", stage], root);
    await rename(join(stage, "package-lock.json"), join(stage, "npm-shrinkwrap.json"));
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", stage], root);
    const runtimeRoot = join(stage, "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "package.json"), `${JSON.stringify({
      name: `insuremo-dsh-runtime-${channel}`,
      version: input.bootstrapVersion,
      type: "module",
      dependencies: {
        "@deepseek-ai/dsh": input.dshVersion,
        "@deepseek-ai/dsh-base": input.dshVersion,
        "@deepseek-ai/dsh-web-app": input.dshVersion,
        "@deepseek-ai/cordis": "4.0.1",
        "@deepseek-ai/cordis-plugin-group": "1.0.1",
        "@icomposer/workbench": "file:../payload/icomposer-workbench.tgz",
      },
    }, null, 2)}\n`);
    await auditExactDshGraph(input.dshGraphPackages, input.dshVersion);
    await writeFile(join(runtimeRoot, "pnpm-workspace.yaml"), stringifyYaml({
      packages: ["."],
      nodeLinker: "hoisted",
      autoInstallPeers: true,
      allowBuilds: { "node-pty": true, koffi: true },
      overrides: {
        ...Object.fromEntries(input.dshGraphPackages.map(name => [name, input.dshVersion])),
        ...knownPeerOverrides,
      },
    }));
    runPnpm(["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"], runtimeRoot);
    runPnpm(["install", "--frozen-lockfile", "--ignore-scripts"], runtimeRoot);
    const runtime = await verifyRuntime(runtimeRoot, input);
    if (runtime.dshIntegrity === undefined || runtime.baseIntegrity === undefined || runtime.webAppIntegrity === undefined) throw new Error(`${channel}: runtime lock omitted a core integrity`);
    await rm(join(runtimeRoot, "node_modules"), { recursive: true, force: true });
    const channelManifest = {
      schemaVersion: 1,
      channel,
      bootstrapVersion: input.bootstrapVersion,
      runtime: {
        packageManager: `pnpm@${input.pnpmVersion}`,
        pnpm: { name: "pnpm", version: input.pnpmVersion },
        dsh: { name: "@deepseek-ai/dsh", version: input.dshVersion, integrity: runtime.dshIntegrity },
        base: { name: "@deepseek-ai/dsh-base", version: input.dshVersion, integrity: runtime.baseIntegrity },
        webApp: { name: "@deepseek-ai/dsh-web-app", version: input.dshVersion, integrity: runtime.webAppIntegrity },
        lockFile: "runtime/pnpm-lock.yaml",
        packageFile: "runtime/package.json",
        workspaceFile: "runtime/pnpm-workspace.yaml",
        lockfileVersion: runtime.lockfileVersion,
        lockSha256: runtime.lockSha256,
        packageCount: runtime.packageCount,
        dshPackages: runtime.dshPackages,
        dshGraph: { expectedVersion: input.dshVersion, uniqueVersions: [input.dshVersion], packages: Object.keys(runtime.dshPackages).length },
        lifecycleHooks: runtime.lifecycleHooks,
        rebuildPackages: ["node-pty", "koffi"],
      },
      pnpm: { name: "pnpm", version: input.pnpmVersion },
      workbench: {
        packageName: plugin.packageName,
        version: plugin.version,
        sourceCommit: input.workbenchSourceCommit,
        treeSha256: plugin.treeSha256,
        tgzSha256: plugin.tgzSha256,
        payloadFile: "payload/icomposer-workbench.tgz",
      },
      profile: { name: "icomposer-web", bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@icomposer/workbench"] },
      installSafety: { rootLifecycleHooks: [], runtimeInstallUsesIgnoreScripts: true, lifecycleHooks: runtime.lifecycleHooks },
    };
    await writeFile(join(stage, "channel-manifest.json"), `${JSON.stringify(channelManifest, null, 2)}\n`);
    await assertRootSafe(stage);
    const packedOutput = runNpm(["pack", "--ignore-scripts", "--silent", "--pack-destination", releaseDir], stage).trim().split(/\r?\n/u).pop();
    const packedPath = join(releaseDir, basename(packedOutput));
    if (!(await exists(packedPath))) throw new Error(`${channel}: npm pack did not create ${packedPath}`);
    const output = {
      schemaVersion: 1,
      channel,
      package: "insuremo-dsh-workbench",
      version: input.bootstrapVersion,
      artifact: relative(root, packedPath).split("\\").join("/"),
      size: (await stat(packedPath)).size,
      sha256: await fileSha256(packedPath),
      runtime: channelManifest.runtime,
      workbench: channelManifest.workbench,
    };
    await writeFile(join(releaseDir, `insuremo-dsh-workbench-${channel}-manifest.json`), `${JSON.stringify(output, null, 2)}\n`);
    console.log(`packed ${channel}: ${output.artifact} (${output.size} bytes, ${output.sha256})`);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const channel = process.argv[2];
if (channel !== "stable" && channel !== "next") {
  console.error("usage: node scripts/pack-bootstrap.mjs <stable|next>");
  process.exit(2);
}
await mkdir(releaseDir, { recursive: true });
await packChannel(channel);
