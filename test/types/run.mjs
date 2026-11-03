#!/usr/bin/env node
/**
 * TASK-167a type-contract gate.
 *
 * For rc.2 and rc.5 it installs the PUBLISHED `@deepseek-ai/*` tarballs into a
 * throwaway `/tmp` project (never the repo `node_modules`), copies the contract
 * sources next to them, and compiles with `strict`. Positive cases must pass;
 * negative cases must fail with at least three diagnostics. `--listFiles` and
 * `--traceResolution` prove the compiler loaded the target version's
 * declarations, not a repo shim or the sibling Harness checkout.
 *
 * No install, lockfile, devDependency, or checkout mutation: tarballs are
 * fetched (read-only GET) into `/tmp` and deleted in `finally`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromVerify = createRequire(join(root, "packages/icomposer-verify/package.json"));
const tsc = requireFromVerify.resolve("typescript/bin/tsc");
const versions = [
  { id: "rc.2", version: "0.2.1-rc.2" },
  { id: "rc.5", version: "0.2.1-rc.5" },
];
const VENDORED = [
  { name: "cordis", version: "4.0.5" },
  { name: "schemastery", version: "3.18.5" },
];
const PACKAGES = [
  "dsh-agent", "dsh-api-remote-access", "dsh-api-remotes", "dsh-api-session-controller",
  "dsh-api-workspace-controller", "dsh-attachment", "dsh-brand", "dsh-client-locale",
  "dsh-client-modules", "dsh-client-shortcuts", "dsh-client-store", "dsh-client-ui-chat",
  "dsh-client-ui-conversation", "dsh-client-ui-layout", "dsh-client-ui-primitives",
  "dsh-client-ui-renderer", "dsh-client-ui-session", "dsh-client-ui-settings",
  "dsh-client-ui-sidebar", "dsh-client-ui-slots", "dsh-client-ui-tool",
  "dsh-client-ui-workspace", "dsh-client-web", "dsh-commands", "dsh-host-directory-picker",
  "dsh-host-webserver", "dsh-jobs", "dsh-llm", "dsh-llm-retry", "dsh-native-command",
  "dsh-package-manifest", "dsh-ptc-runtime", "dsh-sandbox", "dsh-scope", "dsh-session",
  "dsh-skill", "dsh-storage", "dsh-storage-domain", "dsh-subprocess", "dsh-system-prompt",
  "dsh-token-meter", "dsh-tool-todo", "dsh-tools", "dsh-typert-protocol",
  "dsh-user-approval", "dsh-user-questions", "dsh-util-code-language", "dsh-util-crypto",
  "dsh-util-values", "dsh-workspace",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchTarball(dir, name, version) {
  const file = join(dir, `${name}-${version}.tgz`);
  if (existsSync(file)) return file;
  const url = `https://registry.npmjs.org/@deepseek-ai/${name}/-/${name}-${version}.tgz`;
  const response = await fetch(url, { redirect: "follow" });
  assert(response.ok, `cannot download ${name}@${version}: HTTP ${response.status}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function extract(tarball, target) {
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], { stdio: "ignore" });
}

async function linkStoreModule(nodeModules, relative) {
  const store = join(root, "node_modules/.pnpm/node_modules", relative);
  assert(existsSync(store), `repo pnpm store lacks ${relative}; cannot resolve React/Node types offline`);
  const { symlink } = await import("node:fs/promises");
  await symlink(store, join(nodeModules, relative));
}

async function buildVersion(tmp, version, cache) {
  const project = join(tmp, version.id);
  const nodeModules = join(project, "node_modules");
  const scope = join(nodeModules, "@deepseek-ai");
  await mkdir(scope, { recursive: true });
  for (const name of PACKAGES) {
    const tarball = await fetchTarball(cache, name, version.version);
    extract(tarball, join(scope, name));
  }
  for (const { name, version: vendored } of VENDORED) {
    const tarball = await fetchTarball(cache, name, vendored);
    extract(tarball, join(scope, name));
  }
  for (const name of ["react", "react-dom", "scheduler", "csstype"]) await linkStoreModule(nodeModules, name);
  await mkdir(join(nodeModules, "@types"), { recursive: true });
  for (const name of ["react", "react-dom", "node"]) {
    await linkStoreModule(nodeModules, `@types/${name}`);
  }
  await cp(join(root, "test/types/contract.ts"), join(project, "contract.ts"));
  await cp(join(root, "test/types/negative.ts"), join(project, "negative.ts"));
  const compilerOptions = {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    ignoreDeprecations: "6.0",
    jsx: "react-jsx",
    types: ["node"],
    typeRoots: [join(nodeModules, "@types")],
  };
  await writeFile(join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions,
    include: ["contract.ts"],
  }, null, 2));
  await writeFile(join(project, "tsconfig.negative.json"), JSON.stringify({
    compilerOptions,
    include: ["negative.ts"],
  }, null, 2));
  return project;
}

function runTsc(project, config, extraArgs) {
  const result = spawnSync(process.execPath, [tsc, "-p", join(project, config), "--pretty", "false", ...extraArgs], {
    cwd: project,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: join(project, ".home"), TMPDIR: join(project, ".tmp") },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function main() {
  const tmp = await mkdtemp("/tmp/workbench-types-");
  const cache = join(tmp, "tarballs");
  await mkdir(cache);
  try {
    for (const version of versions) {
      const project = await buildVersion(tmp, version, cache);
      await mkdir(join(project, ".home"));
      await mkdir(join(project, ".tmp"));

      const positive = runTsc(project, "tsconfig.json", ["--listFiles", "--traceResolution"]);
      if (positive.status !== 0) {
        const errors = positive.output.split("\n").filter(line => /error TS/.test(line));
        console.error(errors.slice(0, 40).join("\n"));
        throw new Error(`${version.id}: positive contract failed (${errors.length} diagnostics)`);
      }
      const files = positive.output.split("\n");
      const realProject = realpathSync(project);
      const required = [
        join(realProject, "node_modules/@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts"),
        join(realProject, "node_modules/@deepseek-ai/cordis/lib/types/index.d.ts"),
        join(realProject, "node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts"),
      ];
      for (const file of required) {
        assert(files.some(line => line.trim() === file), `${version.id}: --listFiles missing ${file}`);
      }
      assert(!positive.output.includes("harness-shims.d.ts"), `${version.id}: compiled a repo shim`);
      assert(!positive.output.includes(`${sep}deepseek-harness${sep}`), `${version.id}: compiled the sibling Harness checkout`);
      assert(
        positive.output.includes(`Module name '@deepseek-ai/dsh-client-ui-slots' was successfully resolved`) &&
          positive.output.includes(join(realProject, "node_modules/@deepseek-ai/dsh-client-ui-slots")),
        `${version.id}: --traceResolution did not resolve the target declaration`,
      );

      const negative = runTsc(project, "tsconfig.negative.json", []);
      assert(negative.status !== 0, `${version.id}: negative contract compiled successfully (cases no longer reject)`);
      const diagnostics = negative.output.split("\n").filter(line => /negative\.ts\(\d+,\d+\): error TS/.test(line));
      assert(diagnostics.length >= 3, `${version.id}: expected >=3 negative diagnostics, got ${diagnostics.length}`);
      assert(!/contract\.ts\(\d+,\d+\): error TS/.test(negative.output), `${version.id}: positive file failed inside negative project`);

      console.log(`${version.id}: positive OK (${files.filter(line => line.includes("@deepseek-ai/")).length} declaration files), negative OK (${diagnostics.length} diagnostics)`);
    }
    console.log("TASK-167a contract gate passed: rc.2 and rc.5 published declarations, strict, positives pass, negatives fail.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    console.log("Removed the isolated /tmp type project.");
  }
}

main().catch(error => {
  console.error(`TASK-167a type contract failed: ${error.message}`);
  process.exitCode = 1;
});
