import { randomBytes } from "node:crypto";
import { open, readdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHANNEL_NAMES,
  GENERATION_ID_PATTERN,
  OPERATION_ID_PATTERN,
  ensureManagedDir,
  lockPath,
  newOperationId,
  receiptPath,
  receiptsDir,
  writeFileReplace,
} from "./paths.mjs";

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "operationId",
  "operation",
  "status",
  "channel",
  "bootstrapVersion",
  "generationId",
  "startedAt",
  "finishedAt",
  "bootSmoke",
  "error",
]);
const RECEIPT_STATUS = new Set(["prepared", "committed", "abandoned"]);
const RECEIPT_OPERATIONS = new Set(["setup"]);

/** Receipts never carry filesystem paths; every path is derived from the validated operation id. */
export function validateReceiptSchema(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("receipt is not an object");
  const unknown = Object.keys(record).filter(key => !RECEIPT_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`receipt has unknown fields: ${unknown.sort().join(", ")}`);
  if (record.schemaVersion !== 1) throw new Error("receipt schemaVersion must be 1");
  if (typeof record.operationId !== "string" || !OPERATION_ID_PATTERN.test(record.operationId)) throw new Error("receipt has an invalid operationId");
  if (!RECEIPT_OPERATIONS.has(record.operation)) throw new Error(`receipt has an invalid operation: ${JSON.stringify(record.operation)}`);
  if (!RECEIPT_STATUS.has(record.status)) throw new Error(`receipt has an invalid status: ${JSON.stringify(record.status)}`);
  if (typeof record.channel !== "string" || !CHANNEL_NAMES.has(record.channel)) throw new Error("receipt has an invalid channel");
  if (typeof record.bootstrapVersion !== "string" || record.bootstrapVersion === "") throw new Error("receipt has an invalid bootstrapVersion");
  if (record.generationId !== undefined && (typeof record.generationId !== "string" || !GENERATION_ID_PATTERN.test(record.generationId))) {
    throw new Error("receipt has an invalid generationId");
  }
  for (const field of ["startedAt", "finishedAt"]) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || Number.isNaN(Date.parse(record[field])))) {
      throw new Error(`receipt has an invalid ${field}`);
    }
  }
  if (record.error !== undefined && typeof record.error !== "string") throw new Error("receipt error must be a string");
  if (record.bootSmoke !== undefined) {
    const smoke = record.bootSmoke;
    if (smoke === null || typeof smoke !== "object" || smoke.ok !== true || !Number.isInteger(smoke.port)) {
      throw new Error("receipt bootSmoke must be { ok: true, port }");
    }
  }
  return record;
}

function recoveryError(detail) {
  return new Error(`recovery-required: ${detail}`);
}

export async function writeReceipt(dshHome, receipt) {
  const validated = validateReceiptSchema(receipt);
  await writeFileReplace(receiptPath(dshHome, validated.operationId), `${JSON.stringify(validated, null, 2)}\n`);
}

export async function readReceipts(dshHome) {
  const names = await readdir(receiptsDir(dshHome)).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const name of names.filter(name => name.endsWith(".json")).sort()) {
    let record;
    try {
      record = validateReceiptSchema(JSON.parse(await readFile(`${receiptsDir(dshHome)}/${name}`, "utf8")));
    } catch (error) {
      throw recoveryError(`unreadable receipt ${name}: ${error.message}`);
    }
    if (name !== `${record.operationId}.json`) throw recoveryError(`receipt filename does not match its operationId: ${name}`);
    records.push(record);
  }
  return records;
}

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Exclusive lock with dead-owner reclaim: a lock whose pid is gone and whose token still matches may be unlinked. */
export async function acquireLock(dshHome) {
  const path = lockPath(dshHome);
  await ensureLocksDir(dshHome);
  const token = randomBytes(16).toString("hex");
  const payload = `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(path, "wx");
      await handle.writeFile(payload);
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
      const holder = await readLock(path);
      if (holder === undefined || !Number.isInteger(holder.pid) || typeof holder.token !== "string") {
        throw new Error(`busy: the profile lock at ${path} is unreadable; resolve it manually (no operation is running from this installer)`);
      }
      if (ownerAlive(holder.pid)) {
        throw new Error(`busy: another insuremo-dsh profile operation is running (pid ${holder.pid}, started ${holder.startedAt ?? "unknown"})`);
      }
      const confirmed = await readLock(path);
      if (confirmed?.token !== holder.token) continue;
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    return async () => {
      const current = await readLock(path);
      if (current?.token === token) await rm(path, { force: true }).catch(() => undefined);
    };
  }
  throw new Error("busy: could not acquire the profile lock after reclaim attempts");
}

async function ensureLocksDir(dshHome) {
  await ensureManagedDir(dshHome, dirname(lockPath(dshHome)));
}
export function newReceipt(operation, manifest, generationId) {
  return {
    schemaVersion: 1,
    operationId: newOperationId(),
    operation,
    status: "prepared",
    channel: manifest.channel,
    bootstrapVersion: manifest.bootstrapVersion,
    generationId,
    startedAt: new Date().toISOString(),
  };
}
