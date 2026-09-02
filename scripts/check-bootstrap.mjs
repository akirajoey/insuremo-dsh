#!/usr/bin/env node
/** Verify packed bootstrap artifacts pin the exact audited DSH graph. Fails on any mixed DSH closure. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { assertManifestDshGraph, dshLockEntryVersion, readChannelConfig } from "../packages/insuremo-dsh-workbench-bootstrap/src/channel.mjs";
import { fileSha256 } from "../packages/insuremo-dsh-workbench-bootstrap/src/paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "dist-release");

function fail(channel, message) {
  throw new Error(`check-bootstrap ${channel}: ${message}`);
}

async function assertNoReleaseResidues() {
  let names;
  try {
    names = await readdir(releaseDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const residuals = names.filter(name => name.startsWith(".bootstrap-stage-") || name.startsWith(".backup-"));
  if (residuals.length > 0) {
    throw new Error(`check-bootstrap: release directory has unfinished temporary entries: ${residuals.join(", ")}`);
  }
}

function assertNoMixedDshLock(channel, lock, expectedVersion) {
  const sections = [lock.packages ?? {}, lock.snapshots ?? {}];
  for (const section of sections) {
    for (const key of Object.keys(section)) {
      const entry = dshLockEntryVersion(key);
      if (entry === undefined) continue;
      if (entry.version !== expectedVersion) fail(channel, `runtime lock entry ${key} is ${entry.version}, expected exact ${expectedVersion}`);
    }
  }
}

async function checkChannel(channel) {
  const input = await readChannelConfig(root, channel);
  const artifactPath = join(releaseDir, `insuremo-dsh-workbench-${input.bootstrapVersion}.tgz`);
  const manifestPath = join(releaseDir, `insuremo-dsh-workbench-${channel}-manifest.json`);
  const [artifactStat, manifestText] = await Promise.all([stat(artifactPath), readFile(manifestPath, "utf8")]);
  const summary = JSON.parse(manifestText);
  if (summary.channel !== channel || summary.version !== input.bootstrapVersion) fail(channel, "dist-release manifest identity mismatch");
  if (summary.sha256 !== await fileSha256(artifactPath)) fail(channel, "dist-release manifest sha256 does not match the packed tgz");
  if (summary.size !== artifactStat.size) fail(channel, "dist-release manifest size does not match the packed tgz");
  if (summary.workbench?.sourceCommit !== input.workbenchSourceCommit) fail(channel, "dist-release manifest sourceCommit does not match the configured pin");
  assertManifestDshGraph(input, summary.runtime);

  const extractDir = await mkdtemp(join(tmpdir(), `check-bootstrap-${channel}-`));
  try {
    execFileSync("tar", ["-xzf", artifactPath, "-C", extractDir], { stdio: "ignore" });
    const packageDir = join(extractDir, "package");
    const shippedManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    if (shippedManifest.private !== undefined || shippedManifest.scripts !== undefined || shippedManifest.devDependencies !== undefined) {
      fail(channel, "shipped package manifest has forbidden fields");
    }
    if (shippedManifest.bundleDependencies?.includes("pnpm") !== true) fail(channel, "pnpm is not bundled in the shipped package");
    const embedded = JSON.parse(await readFile(join(packageDir, "channel-manifest.json"), "utf8"));
    if (JSON.stringify(embedded.runtime.dshPackages) !== JSON.stringify(summary.runtime.dshPackages)) fail(channel, "embedded manifest DSH package map diverged from the dist-release copy");
    const workspace = parseYaml(await readFile(join(packageDir, "runtime", "pnpm-workspace.yaml"), "utf8"));
    const overrides = workspace?.overrides ?? {};
    for (const [name, version] of Object.entries(overrides)) {
      if (name.startsWith("@deepseek-ai/dsh")) {
        if (version !== input.dshVersion) fail(channel, `shipped workspace override ${name} is ${version}, expected exact ${input.dshVersion}`);
      }
    }
    for (const name of input.dshGraphPackages) {
      if (overrides[name] !== input.dshVersion) fail(channel, `shipped workspace is missing an exact override for ${name}`);
    }
    const lock = parseYaml(await readFile(join(packageDir, "runtime", "pnpm-lock.yaml"), "utf8"));
    assertNoMixedDshLock(channel, lock, input.dshVersion);
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
  console.log(`check-bootstrap ${channel}: exact ${input.dshVersion} graph verified (${Object.keys(summary.runtime.dshPackages).length} DSH packages)`);
}

const channels = ["stable", "next"];
await assertNoReleaseResidues();
const available = [];
for (const channel of channels) {
  try {
    await readFile(join(releaseDir, `insuremo-dsh-workbench-${channel}-manifest.json`), "utf8");
    available.push(channel);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const missing = channels.filter(channel => !available.includes(channel));
if (missing.length > 0) {
  console.error(`check-bootstrap: release gate requires both channel artifacts; missing: ${missing.join(", ")}. Run pnpm pack:bootstrap first.`);
  process.exit(1);
}
for (const channel of available) await checkChannel(channel);
