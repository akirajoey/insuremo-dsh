import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PROFILE_BUNDLES,
  assertContainedSymlinks,
  assertWithin,
  pathExists,
  profileDirByName,
  treeSha256,
} from "./paths.mjs";
import { runPluginAdd } from "./runtime.mjs";

const REQUIRED_BUNDLES = [...PROFILE_BUNDLES];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`invalid JSON at ${path}: ${error.message}`);
  }
}

function assertOrderedRequiredBundles(bundles) {
  const positions = REQUIRED_BUNDLES.map(bundle => bundles.indexOf(bundle));
  if (positions.some(position => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new Error(`profile does not contain ordered base/web/Workbench bundles: ${JSON.stringify(bundles)}`);
  }
}

export async function inspectProfileDir(home, profileName) {
  const dir = profileDirByName(home, profileName);
  if (!(await pathExists(dir))) return { exists: false, dir, profileName };
  const manifest = await readJson(join(dir, "package.json"));
  if (manifest === undefined) throw new Error(`profile directory has no package.json: ${dir}`);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return { exists: true, dir, profileName, manifest, bundles, bundleSet: new Set(bundles) };
}

export async function verifyProfileDir(home, profileName, expected, dshVersion) {
  const profile = await inspectProfileDir(home, profileName);
  if (!profile.exists) throw new Error(`profile is missing: ${profileName}`);
  assertOrderedRequiredBundles(profile.bundles);
  if (profile.manifest.dependencies?.["@deepseek-ai/dsh-web-app"] !== dshVersion) {
    throw new Error("profile web-app dependency drifted from the release manifest");
  }
  const installed = join(profile.dir, "node_modules", "@icomposer", "workbench");
  const homeReal = await realpath(home);
  await assertWithin(homeReal, profile.dir);
  if (!(await pathExists(installed))) throw new Error("profile Workbench package is missing");
  const installedReal = await realpath(installed);
  await assertWithin(homeReal, installedReal);
  const manifest = await readJson(join(installedReal, "package.json"));
  if (manifest?.name !== "@icomposer/workbench" || manifest.version !== expected.version) {
    throw new Error("profile Workbench identity drifted");
  }
  const digest = await treeSha256(installedReal);
  if (digest !== expected.treeSha256) throw new Error(`profile Workbench payload drifted: ${digest}`);
  await assertContainedSymlinks(profile.dir);
  return { ...profile, installedReal, payloadSha256: digest, profileDigest: await treeSha256(profile.dir) };
}

/** Builds a brand-new profile in staging; nothing from an existing profile is read or copied. */
export async function stageFreshProfile({ stagingHome, profileName, operationRoot, runtimeRoot, storeDir, manifest, payloadTgz }) {
  await mkdir(stagingHome, { recursive: true });
  if (await pathExists(join(stagingHome, "profiles", profileName))) {
    throw new Error("staging profile already exists; refusing to build over it");
  }
  await runPluginAdd(stagingHome, profileName, manifest.runtime.webApp.version, payloadTgz, operationRoot, runtimeRoot, storeDir);
  const staged = await inspectProfileDir(stagingHome, profileName);
  if (!staged.exists) throw new Error("staged profile was not created");
  assertOrderedRequiredBundles(staged.bundles);
  const webAppSpec = staged.manifest.dependencies?.["@deepseek-ai/dsh-web-app"];
  if (webAppSpec !== manifest.runtime.webApp.version) throw new Error(`staged web-app dependency is not exact: ${webAppSpec}`);
  const workbenchSpec = staged.manifest.dependencies?.["@icomposer/workbench"];
  if (typeof workbenchSpec !== "string" || !workbenchSpec.startsWith("file:")) throw new Error("staged Workbench dependency is not the internal payload");
  const installed = join(staged.dir, "node_modules", "@icomposer", "workbench");
  const stagingReal = await realpath(stagingHome);
  const installedReal = await realpath(installed);
  await assertWithin(stagingReal, installedReal);
  const installedManifest = await readJson(join(installedReal, "package.json"));
  if (installedManifest?.name !== "@icomposer/workbench" || installedManifest.version !== manifest.workbench.version) {
    throw new Error("staged Workbench identity mismatch");
  }
  const installedDigest = await treeSha256(installedReal);
  if (installedDigest !== manifest.workbench.treeSha256) throw new Error(`staged Workbench payload digest mismatch: ${installedDigest}`);
  await assertContainedSymlinks(staged.dir);
  return { stagingProfile: staged.dir, staged, installedReal, payloadSha256: installedDigest, profileDigest: await treeSha256(staged.dir) };
}

export async function copySnapshotFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: false });
}
