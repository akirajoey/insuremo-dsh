import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_DIR_NAME,
  GENERATION_RECORD_PATTERN,
  ensureManagedDir,
  fileSha256,
  generationDir,
  generationRecordName,
  generationRecordPath,
  generationsDir,
  pathExists,
  profileDirByName,
  profileNameFor,
  resolveDshHome,
  stagingDir,
  treeSha256,
  writeFileReplace,
} from "./paths.mjs";
import { stageFreshProfile, verifyProfileDir } from "./profile.mjs";
import { acquireLock, newReceipt, readReceipts, writeReceipt } from "./receipts.mjs";
import { assertRuntimeIdentity, bootSmoke, installRuntime, scanInstalledDshGraph } from "./runtime.mjs";

function sha8(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export function rejectUnsafeArgs(args) {
  for (const arg of args) {
    if (/^--(profile|channel)(=|$)/iu.test(arg) || arg === "plugin" || arg === "dump-config") {
      throw new Error(`insuremo-dsh owns its internal profile and channel; ${JSON.stringify(arg)} is not accepted`);
    }
  }
}

export function generationIdFromManifest(manifest) {
  return sha8(JSON.stringify({
    channel: manifest.channel,
    bootstrapVersion: manifest.bootstrapVersion,
    dshVersion: manifest.runtime.dsh.version,
    pnpmVersion: manifest.runtime.pnpm.version,
    workbenchVersion: manifest.workbench.version,
    workbenchTreeSha256: manifest.workbench.treeSha256,
    workbenchTgzSha256: manifest.workbench.tgzSha256,
    runtimeLockSha256: manifest.runtime.lockSha256,
  }));
}

function recordFromManifest(manifest, generationId, profileDigest) {
  return {
    schemaVersion: 1,
    generationId,
    channel: manifest.channel,
    bootstrapVersion: manifest.bootstrapVersion,
    dshVersion: manifest.runtime.dsh.version,
    pnpmVersion: manifest.runtime.pnpm.version,
    workbench: { version: manifest.workbench.version, treeSha256: manifest.workbench.treeSha256, tgzSha256: manifest.workbench.tgzSha256 },
    profileName: profileNameFor(manifest.channel, generationId),
    profileDigest,
    dshPackages: manifest.runtime.dshPackages,
    runtimeLockSha256: manifest.runtime.lockSha256,
    committedAt: new Date().toISOString(),
  };
}

function validateGenerationRecord(record, channel, generationId) {
  const fail = message => { throw new Error(`invalid generation record ${generationRecordName(channel, generationId)}: ${message}`); };
  if (record === null || typeof record !== "object" || Array.isArray(record)) fail("not an object");
  if (record.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (record.generationId !== generationId) fail("generationId mismatch");
  if (record.channel !== channel) fail("channel mismatch");
  if (typeof record.bootstrapVersion !== "string" || record.bootstrapVersion === "") fail("bootstrapVersion missing");
  if (typeof record.dshVersion !== "string" || record.dshVersion === "") fail("dshVersion missing");
  if (typeof record.pnpmVersion !== "string" || record.pnpmVersion === "") fail("pnpmVersion missing");
  const workbench = record.workbench ?? {};
  for (const field of ["version", "treeSha256", "tgzSha256"]) {
    if (typeof workbench[field] !== "string" || workbench[field] === "") fail(`workbench.${field} missing`);
  }
  if (record.profileName !== profileNameFor(channel, generationId)) fail("profileName mismatch");
  if (typeof record.profileDigest !== "string" || !/^[0-9a-f]{64}$/u.test(record.profileDigest)) fail("profileDigest invalid");
  if (record.dshPackages === null || typeof record.dshPackages !== "object" || Array.isArray(record.dshPackages)) fail("dshPackages missing");
  if (typeof record.committedAt !== "string" || Number.isNaN(Date.parse(record.committedAt))) fail("committedAt invalid");
  return record;
}

async function readGenerationRecord(home, channel, generationId) {
  let content;
  try {
    content = await readFile(generationRecordPath(home, channel, generationId), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid generation record ${generationRecordName(channel, generationId)}: ${error.message}`);
  }
  return validateGenerationRecord(parsed, channel, generationId);
}

async function writeGenerationRecord(home, manifest, generationId, profileDigest) {
  const record = recordFromManifest(manifest, generationId, profileDigest);
  await writeFileReplace(generationRecordPath(home, manifest.channel, generationId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Verifies a generation record against the on-disk profile, runtime, exact DSH graph, and payload snapshot. */
export async function verifyGenerationRecord(home, record) {
  const expected = {
    version: record.workbench.version,
    treeSha256: record.workbench.treeSha256,
  };
  const profile = await verifyProfileDir(home, record.profileName, expected, record.dshVersion);
  const runtimeRoot = join(generationDir(home, record.channel, record.generationId), "runtime");
  const identityManifest = {
    runtime: {
      dsh: { version: record.dshVersion },
      pnpm: { version: record.pnpmVersion },
      base: { version: record.dshVersion },
      webApp: { version: record.dshVersion },
    },
  };
  await assertRuntimeIdentity(runtimeRoot, identityManifest);
  const graph = await scanInstalledDshGraph(runtimeRoot);
  const expectedGraph = record.dshPackages ?? {};
  for (const [name, version] of Object.entries(expectedGraph)) {
    if (graph[name] !== version) throw new Error(`generation runtime graph drifted at ${name}: ${graph[name] ?? "missing"} != ${version}`);
  }
  if (Object.keys(graph).length !== Object.keys(expectedGraph).length) {
    throw new Error(`generation runtime graph has unexpected DSH packages: ${Object.keys(graph).length} != ${Object.keys(expectedGraph).length}`);
  }
  const payloadSnapshot = join(generationDir(home, record.channel, record.generationId), "payload", "icomposer-workbench.tgz");
  if (await fileSha256(payloadSnapshot) !== record.workbench.tgzSha256) throw new Error("generation payload snapshot drifted");
  return { profileName: record.profileName, profileDigest: profile.profileDigest, runtimeRoot, graphCount: Object.keys(graph).length };
}

/** Builds and returns the committed generation for this exact artifact, or undefined when not set up. */
export async function currentGeneration(home, manifest) {
  const generationId = generationIdFromManifest(manifest);
  const record = await readGenerationRecord(home, manifest.channel, generationId);
  if (record === undefined) return undefined;
  return { record, verified: await verifyGenerationRecord(home, record) };
}

export async function recoverPending(home) {
  for (const receipt of await readReceipts(home)) {
    if (receipt.status !== "prepared") continue;
    await rm(stagingDir(home, receipt.operationId), { recursive: true, force: true });
    await writeReceipt(home, { ...receipt, status: "abandoned", finishedAt: new Date().toISOString() });
  }
}

async function verifyEmbeddedPayload(packageRoot, manifest) {
  const payload = join(packageRoot, manifest.workbench.payloadFile);
  if (!(await pathExists(payload))) throw new Error(`embedded Workbench payload missing: ${manifest.workbench.payloadFile}`);
  if (await fileSha256(payload) !== manifest.workbench.tgzSha256) throw new Error("embedded Workbench payload hash mismatch");
  return payload;
}

async function commitGeneration(home, manifest, generationId, stage) {
  const profileName = profileNameFor(manifest.channel, generationId);
  const targetProfile = profileDirByName(home, profileName);
  if (await pathExists(targetProfile)) throw new Error(`profile-conflict: ${profileName} already exists; no files were changed`);
  await ensureManagedDir(home, generationsDir(home));
  await ensureManagedDir(home, join(home, "profiles"));
  const genDir = generationDir(home, manifest.channel, generationId);
  const payloadSnapshot = join(genDir, "payload", "icomposer-workbench.tgz");
  if (await pathExists(genDir)) {
    await assertRuntimeIdentity(join(genDir, "runtime"), manifest);
    if (await fileSha256(payloadSnapshot) !== manifest.workbench.tgzSha256) throw new Error("existing generation payload snapshot drifted; no files were changed");
  } else {
    await mkdir(genDir);
    await mkdir(join(genDir, "payload"));
    await cp(stage.payloadPath, payloadSnapshot, { force: false });
    if (await fileSha256(payloadSnapshot) !== manifest.workbench.tgzSha256) throw new Error("generation payload snapshot copy changed bytes");
    await rename(stage.stagingRuntime, join(genDir, "runtime"));
  }
  await rename(stage.stagingProfile, targetProfile);
  const record = await readGenerationRecord(home, manifest.channel, generationId);
  if (record !== undefined) throw new Error("generation record already exists; refusing to overwrite");
  const verifiedProfile = await verifyProfileDir(home, profileName, { version: manifest.workbench.version, treeSha256: manifest.workbench.treeSha256 }, manifest.runtime.dsh.version);
  await writeGenerationRecord(home, manifest, generationId, verifiedProfile.profileDigest);
}

export async function ensureSetup(manifest, packageRoot, operation = "setup") {
  const home = resolveDshHome();
  const unlock = await acquireLock(home);
  try {
    await recoverPending(home);
    const payload = await verifyEmbeddedPayload(packageRoot, manifest);
    const generationId = generationIdFromManifest(manifest);
    const profileName = profileNameFor(manifest.channel, generationId);
    const existingRecord = await readGenerationRecord(home, manifest.channel, generationId);
    if (existingRecord !== undefined) {
      await verifyGenerationRecord(home, existingRecord);
      return { ok: true, changed: false, profileName, generationId };
    }
    if (await pathExists(profileDirByName(home, profileName))) {
      let rebuilt;
      try {
        const profile = await verifyProfileDir(home, profileName, { version: manifest.workbench.version, treeSha256: manifest.workbench.treeSha256 }, manifest.runtime.dsh.version);
        const genDir = generationDir(home, manifest.channel, generationId);
        await assertRuntimeIdentity(join(genDir, "runtime"), manifest);
        const graph = await scanInstalledDshGraph(join(genDir, "runtime"));
        for (const [name, version] of Object.entries(manifest.runtime.dshPackages)) {
          if (graph[name] !== version) throw new Error(`runtime graph drifted at ${name}`);
        }
        if (await fileSha256(join(genDir, "payload", "icomposer-workbench.tgz")) !== manifest.workbench.tgzSha256) throw new Error("payload snapshot drifted");
        rebuilt = profile;
      } catch (error) {
        throw new Error(`profile-conflict: ${profileName} exists but does not match this release (${error.message}); no files were changed`);
      }
      await writeGenerationRecord(home, manifest, generationId, rebuilt.profileDigest);
      return { ok: true, changed: false, adopted: true, profileName, generationId };
    }
    const receipt = newReceipt(operation, manifest, generationId);
    await writeReceipt(home, receipt);
    const staging = stagingDir(home, receipt.operationId);
    try {
      const sharedStore = join(home, APP_DIR_NAME, "pnpm-store");
      const runtimeStage = await installRuntime({ packageRoot, operationRoot: staging, dshHome: join(staging, "home"), manifest, storeDir: sharedStore });
      const stageHome = join(staging, "home");
      const staged = await stageFreshProfile({
        stagingHome: stageHome,
        profileName,
        operationRoot: staging,
        runtimeRoot: runtimeStage.runtimeRoot,
        storeDir: sharedStore,
        manifest,
        payloadTgz: runtimeStage.payloadPath,
      });
      const smoke = await bootSmoke(stageHome, profileName, runtimeStage.runtimeRoot);
      await commitGeneration(home, manifest, generationId, {
        stagingProfile: staged.stagingProfile,
        stagingRuntime: runtimeStage.runtimeRoot,
        payloadPath: runtimeStage.payloadPath,
      });
      await writeReceipt(home, { ...receipt, status: "committed", finishedAt: new Date().toISOString(), bootSmoke: { ok: true, port: smoke.port } });
      return { ok: true, changed: true, profileName, generationId };
    } catch (error) {
      await writeReceipt(home, { ...receipt, status: "abandoned", finishedAt: new Date().toISOString(), error: error.message }).catch(() => undefined);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await unlock();
  }
}

export async function doctor(manifest, packageRoot) {
  const home = resolveDshHome();
  const generationId = generationIdFromManifest(manifest);
  const result = {
    ok: false,
    channel: manifest.channel,
    bootstrapVersion: manifest.bootstrapVersion,
    generationId,
    profileName: profileNameFor(manifest.channel, generationId),
    set: false,
    verified: false,
    pendingReceipts: 0,
    legacyProfilePresent: await pathExists(join(home, "profiles", "icomposer-web")),
    payloadMatches: false,
  };
  try {
    result.pendingReceipts = (await readReceipts(home)).filter(record => record.status === "prepared").length;
    result.payloadMatches = await fileSha256(join(packageRoot, manifest.workbench.payloadFile)) === manifest.workbench.tgzSha256;
    const record = await readGenerationRecord(home, manifest.channel, generationId);
    result.set = record !== undefined;
    if (record !== undefined) {
      const verified = await verifyGenerationRecord(home, record);
      result.verified = true;
      result.profileDigest = verified.profileDigest;
      result.graphCount = verified.graphCount;
    }
  } catch (error) {
    result.error = error.message;
  }
  result.ok = result.payloadMatches && result.pendingReceipts === 0 && result.set && result.verified;
  return result;
}

export async function listCommittedGenerations(home, channel) {
  let names;
  try {
    names = await readdir(generationsDir(home));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names.sort()) {
    const match = GENERATION_RECORD_PATTERN.exec(name);
    if (match === null || match[1] !== channel) continue;
    const generationId = match[2];
    let content;
    try {
      content = await readFile(generationRecordPath(home, channel, generationId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    records.push(validateGenerationRecord(JSON.parse(content), channel, generationId));
  }
  return records.sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
}

/** Launches the newest generation of this channel that still verifies. */
export async function launchLatest(manifest, args = []) {
  const { launchWorkbench } = await import("./runtime.mjs");
  const home = resolveDshHome();
  for (const record of await listCommittedGenerations(home, manifest.channel)) {
    try {
      const verified = await verifyGenerationRecord(home, record);
      return launchWorkbench(home, verified.profileName, verified.runtimeRoot, args);
    } catch {
      // A drifted generation is never launched; the next newest one is tried.
    }
  }
  throw new Error(`no verifiable committed ${manifest.channel} generation; run: insuremo-dsh setup`);
}

export async function ensureThenLaunch(manifest, packageRoot, args = []) {
  const ensured = await ensureSetup(manifest, packageRoot, "setup");
  if (ensured.changed) process.stdout.write(`insuremo-dsh: ${manifest.channel} profile ready (${ensured.profileName})\n`);
  return launchLatest(manifest, args);
}
