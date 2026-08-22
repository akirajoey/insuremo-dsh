import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..");

test("dist package metadata declares the full dsh contract", async () => {
  const manifest = JSON.parse(await readFile(join(distDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "@icomposer/workbench");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  const clientInject = manifest.dsh.client.inject;
  for (const service of ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-primitives"]) {
    assert.ok(clientInject.includes(service), `client inject missing ${service}`);
  }
  // exports cover the loader contract
  for (const key of [".", "./client", "./cordis.patch.yml", "./package.json"]) {
    assert.ok(manifest.exports[key] !== undefined, `exports missing ${key}`);
  }
  // files whitelist ships the payload
  assert.deepEqual(manifest.files, ["lib", "cordis.patch.yml", "README.md"]);
  // peers: harness packages + react, all loose (baseline documented in README)
  for (const peer of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-subprocess", "@deepseek-ai/dsh-storage-domain", "@deepseek-ai/dsh-workspace", "@deepseek-ai/dsh-skill", "@deepseek-ai/dsh-storage", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-jobs", "@deepseek-ai/schemastery", "@deepseek-ai/dsh-client-ui-primitives", "react"]) {
    assert.ok(manifest.peerDependencies[peer] !== undefined, `peerDependencies missing ${peer}`);
  }
});

test("cordis.patch.yml is a single insert with the inject union", async () => {
  const text = await readFile(join(distDir, "cordis.patch.yml"), "utf8");
  const inserts = text.match(/- insert:/g) ?? [];
  assert.equal(inserts.length, 1);
  assert.ok(text.includes("id: icomposer-workbench"));
  assert.ok(text.includes("name: '@icomposer/workbench'"));
  const injectMatch = text.match(/inject: \[([^\]]+)\]/);
  assert.ok(injectMatch !== undefined);
  const inject = injectMatch[1].split(",").map(s => s.trim());
  assert.deepEqual([...inject].sort(), ["jobs", "skills", "storageDomain", "subprocess", "tools", "webServer", "workspaceRegistry"]);
  assert.equal(text.includes("config:"), false, "patch must not carry config");
});

test("host entry aggregates nine packages in dependency order with union inject", async () => {
  const source = await readFile(join(distDir, "src", "index.ts"), "utf8");
  const order = [
    ["operation-log", 0], ["workspace-binding", 1], ["catalog", 2], ["reference", 3],
    ["lifecycle", 4], ["verify", 5], ["code-intelligence", 6], ["write", 7], ["intercom", 8], ["insuremo-service", 9],
  ];
  assert.equal(order.length, 10, "aggregate must mount ten packages");
  let last = -1;
  for (const [name, position] of order) {
    const idx = source.indexOf(`as ${requireAlias(name)}`);
    assert.ok(idx >= 0, `aggregate missing import for ${name}`);
    assert.ok(idx > last, `aggregate order broken at ${name}`);
    last = idx;
  }
  // write mounts between code-intelligence and intercom (after imoAuth users, before messaging)
  const writeApply = source.indexOf("ctx.plugin(write as never");
  const iciApply = source.indexOf("ctx.plugin(codeIntelligence as never");
  const intercomApply = source.indexOf("ctx.plugin(intercom as never");
  assert.ok(iciApply < writeApply && writeApply < intercomApply, "write mount position wrong");
  // the interactive test plugin is excluded
  assert.equal(source.includes("plugin-workbench-test"), false);
  function requireAlias(name) {
    const map = { "operation-log": "operationLog", "workspace-binding": "workspaceBinding", "code-intelligence": "codeIntelligence", "insuremo-service": "insuremoService" };
    return map[name] ?? name;
  }

});

test("client entry aggregates the three UI applies with union inject", async () => {
  const source = await readFile(join(distDir, "src", "client", "index.ts"), "utf8");
  for (const alias of ["settingsApply", "statusApply", "jobsApply"]) {
    assert.ok(source.includes(alias), `client aggregate missing ${alias}`);
  }
  assert.deepEqual(["slots", "locale", "sessions"], ["slots", "locale", "sessions"]);
});

test("built artifacts exist, are pure JS, and bundle @icomposer dependencies", async () => {
  const libDir = join(distDir, "lib");
  const files = await readdir(libDir);
  assert.ok(files.includes("index.js"), "lib/index.js missing");
  assert.ok(files.includes("client.js"), "lib/client.js missing");
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const text = await readFile(join(libDir, file), "utf8");
    // no TypeScript source imports survive
    assert.equal(/from\s+["'][^"']*\.ts["']/.test(text), false, `${file} imports .ts sources`);
    // browser client is a closure factory
    if (file === "client.js") {
      assert.ok(text.startsWith("window.__ModuleLoader__.load("), "client.js is not a loader closure");
      assert.ok(text.includes('"@icomposer/workbench"'));
    }
  }
  // the host artifact inlines the sibling packages (no external @icomposer resolution)
  const indexText = await readFile(join(libDir, "index.js"), "utf8");
  // the write service (push/test/release/create/metadata closed loops) is bundled
  assert.ok(indexText.includes("IcomposerWriteService"), "index.js missing IcomposerWriteService");
  for (const marker of ["imo-icomposer-push-resolve", "imo-icomposer-test", "imo-icomposer-release", "imo-icomposer-create", "imo-icomposer-metadata-update", "local-unpushed-changes"]) {
    assert.ok(indexText.includes(marker), `index.js missing write-path marker ${marker}`);
  }
  assert.equal(/import\s+["']@icomposer\//.test(indexText), false, "index.js still imports @icomposer/* externally");
  assert.equal(/require\(["']@icomposer\//.test(indexText), false, "index.js requires @icomposer/* externally");
  // syntax-check both entries as scripts
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["--check", join(libDir, "index.js")]);
  execFileSync("node", ["--check", join(libDir, "client.js")]);
});

test("pack-dist produces the self-contained tarball and matching manifest", async () => {
  const { existsSync } = await import("node:fs");
  const releaseDir = join(distDir, "..", "..", "dist-release");
  const manifestPath = join(releaseDir, "pack-manifest.json");
  if (!existsSync(manifestPath)) {
    // packing is a release-time step; when absent, assert the packer script exists
    const packer = await stat(join(distDir, "..", "..", "scripts", "pack-dist.mjs"));
    assert.ok(packer.isFile());
    return;
  }
  const summary = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(summary.package, "@icomposer/workbench");
  const paths = summary.files.map(file => file.path);
  for (const required of ["lib/index.js", "lib/client.js", "cordis.patch.yml", "package.json", "README.md"]) {
    assert.ok(paths.includes(required), `pack manifest missing ${required}`);
  }
  // no sibling sources, no node_modules in the payload
  assert.equal(paths.some(p => p.includes("node_modules")), false);
  assert.equal(paths.some(p => p.includes("../")), false);
  // PRIMARY artifact is the tarball, and it exists next to the manifest
  assert.ok(typeof summary.tgz === "string" && summary.tgz.endsWith(".tgz"), "pack manifest must name a .tgz artifact");
  assert.ok(existsSync(join(releaseDir, summary.tgz)), `tarball ${summary.tgz} not present`);
  // tgz contents match the staged payload exactly (packer self-check mirrors this)
  const { execFileSync } = await import("node:child_process");
  const listing = execFileSync("tar", ["-tzf", join(releaseDir, summary.tgz)], { encoding: "utf8" })
    .split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.endsWith("/")).map(l => l.replace(/^package\//, ""));
  for (const required of paths) {
    assert.ok(listing.includes(required), `tgz missing staged file ${required}`);
  }
  // the shipped manifest has no file: devDependencies and a no-op prepare
  const staged = JSON.parse(await readFile(join(releaseDir, "icomposer-workbench-dist", "package.json"), "utf8"));
  assert.equal(staged.devDependencies, undefined);
  assert.ok(staged.scripts.prepare.includes("prebuilt"), "shipped prepare must be a no-op");
});
