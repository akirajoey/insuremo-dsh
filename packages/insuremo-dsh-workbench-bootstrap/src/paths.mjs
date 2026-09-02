import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export const APP_DIR_NAME = "insuremo-dsh";
export const PROFILE_BUNDLES = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@icomposer/workbench",
];
export const CHANNEL_NAMES = new Set(["stable", "next"]);
export const OPERATION_ID_PATTERN = /^[0-9a-z]{6,12}-[0-9a-f]{16}$/u;
export const GENERATION_ID_PATTERN = /^[0-9a-f]{8}$/u;
export const PROFILE_NAME_PATTERN = /^icomposer-web-(stable|next)-[0-9a-f]{8}$/u;
export const GENERATION_RECORD_PATTERN = /^(stable|next)-([0-9a-f]{8})\.json$/u;

export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return resolve(configured || join(homedir(), ".dsh"));
}

export function appRoot(dshHome) {
  return join(dshHome, APP_DIR_NAME);
}

export function lockPath(dshHome) {
  return join(appRoot(dshHome), "locks", "icomposer-web.lock");
}

export function receiptsDir(dshHome) {
  return join(appRoot(dshHome), "receipts");
}

export function receiptPath(dshHome, operationId) {
  assertValidOperationId(operationId);
  return join(receiptsDir(dshHome), `${operationId}.json`);
}

export function stagingDir(dshHome, operationId) {
  assertValidOperationId(operationId);
  return join(appRoot(dshHome), "staging", operationId);
}

export function generationsDir(dshHome) {
  return join(appRoot(dshHome), "generations");
}

export function profileNameFor(channel, generationId) {
  assertValidGenerationId(generationId);
  if (!CHANNEL_NAMES.has(channel)) throw new Error(`invalid channel: ${channel}`);
  return `icomposer-web-${channel}-${generationId}`;
}

export function profileDirByName(dshHome, profileName) {
  if (typeof profileName !== "string" || !PROFILE_NAME_PATTERN.test(profileName)) {
    throw new Error(`invalid managed profile name: ${JSON.stringify(profileName)}`);
  }
  return join(dshHome, "profiles", profileName);
}

export function generationDir(dshHome, channel, generationId) {
  assertValidGenerationId(generationId);
  if (!CHANNEL_NAMES.has(channel)) throw new Error(`invalid channel: ${channel}`);
  return join(generationsDir(dshHome), `${channel}-${generationId}`);
}

export function generationRecordName(channel, generationId) {
  assertValidGenerationId(generationId);
  if (!CHANNEL_NAMES.has(channel)) throw new Error(`invalid channel: ${channel}`);
  return `${channel}-${generationId}.json`;
}

export function generationRecordPath(dshHome, channel, generationId) {
  return join(generationsDir(dshHome), generationRecordName(channel, generationId));
}

export function assertValidOperationId(operationId) {
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(`invalid operation id: ${JSON.stringify(operationId)}`);
  }
}

export function assertValidGenerationId(generationId) {
  if (typeof generationId !== "string" || !GENERATION_ID_PATTERN.test(generationId)) {
    throw new Error(`invalid generation id: ${JSON.stringify(generationId)}`);
  }
}

export function newOperationId() {
  return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function walk(dir, root, output) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const name = relative(root, full).split("\\").join("/");
    if (entry.isDirectory()) {
      await walk(full, root, output);
      continue;
    }
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      const rawTarget = await readlink(full, "utf8");
      let target;
      try {
        target = await realpath(full);
      } catch {
        // A dangling link still has a raw target; resolve it against the link directory.
        target = resolve(dirname(full), rawTarget);
      }
      output.push({ path: name, kind: "symlink", target, rawTarget });
    } else if (info.isFile()) {
      output.push({ path: name, kind: "file", size: info.size, sha256: await fileSha256(full) });
    } else {
      throw new Error(`unsupported non-regular payload entry: ${full}`);
    }
  }
}

export async function treeEntries(root) {
  const output = [];
  await walk(root, root, output);
  return output;
}

export async function treeSha256(root) {
  const entries = await treeEntries(root);
  return sha256(entries.map(entry => JSON.stringify(entry)).join("\n"));
}

async function assertRealDir(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`managed path is not a real directory: ${path}`);
  }
}

/** Rejects symlink/reparse ancestors between `home` and `target`; both must be inside the managed tree. */
export async function assertRealDirectoryChain(home, target) {
  const homeReal = resolve(home);
  const targetReal = resolve(target);
  const rel = relative(homeReal, targetReal).split("\\").join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new Error(`managed path escapes DSH_HOME: ${target}`);
  }
  let current = homeReal;
  for (const part of rel.split("/").filter(part => part !== "" && part !== ".")) {
    current = join(current, part);
    await assertRealDir(current);
  }
}

/** Creates a directory below `home`, verifying every ancestor is a real directory (no symlink traversal). */
export async function ensureManagedDir(home, target) {
  const homeReal = resolve(home);
  const targetReal = resolve(target);
  const rel = relative(homeReal, targetReal).split("\\").join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new Error(`managed path escapes DSH_HOME: ${target}`);
  }
  let current = homeReal;
  const info = await lstat(homeReal).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) await mkdir(homeReal, { recursive: true });
  else await assertRealDir(homeReal);
  for (const part of rel.split("/").filter(part => part !== "" && part !== ".")) {
    current = join(current, part);
    const stat = await lstat(current).catch(error => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat === undefined) await mkdir(current);
    else await assertRealDir(current);
  }
}

/** Atomic same-directory replace: temp file (exclusive) + rename. Never leaves backup files behind. */
export async function writeFileReplace(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWindowsForeignTarget(target) {
  return /^[A-Za-z]:/u.test(target) || target.startsWith("\\\\");
}

export async function assertContainedSymlinks(root) {
  const rootReal = await realpath(root);
  const entries = await treeEntries(root);
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    if (isWindowsForeignTarget(entry.rawTarget ?? entry.target)) {
      throw new Error(`profile symlink target uses a foreign drive or UNC form: ${join(root, entry.path)} -> ${entry.rawTarget ?? entry.target}`);
    }
    const target = resolve(entry.target);
    const escape = relative(rootReal, target).split("\\").join("/");
    if (escape === ".." || escape.startsWith("../") || escape.startsWith("/")) {
      throw new Error(`profile contains an external symlink: ${join(root, entry.path)}`);
    }
  }
  return entries;
}

export async function assertWithin(rootReal, target) {
  if (isWindowsForeignTarget(target)) {
    throw new Error(`path uses a foreign drive or UNC form: ${target}`);
  }
  const rootR = await realpath(rootReal).catch(() => resolve(rootReal));
  const targetR = await realpath(target).catch(() => resolve(target));
  const escape = relative(rootR, targetR).split("\\").join("/");
  if (escape === ".." || escape.startsWith("../") || escape.startsWith("/")) {
    throw new Error(`path escaped the managed root: ${target}`);
  }
}
