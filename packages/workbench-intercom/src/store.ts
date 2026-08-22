import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export const TEXT_LIMIT_BYTES = 64 * 1024;

export function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** Fixed deterministic namespace hash under <DSH_HOME>/intercom/. */
export function intercomBaseDir(): string {
  const hash = createHash("sha256").update("workbench-intercom").digest("hex").slice(0, 16);
  return join(getDshHome(), "intercom", hash);
}

export function messagePath(seq: number): string {
  return join(intercomBaseDir(), "messages", `${seq}.txt`);
}

export function leasePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex");
  return join(intercomBaseDir(), "leases", `${hash}.json`);
}

export function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Text payload constraints: ≤64KB, no NUL bytes, valid UTF-8 string. */
export function isValidText(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > TEXT_LIMIT_BYTES) return false;
  return !text.includes("\u0000");
}

/** Atomic bounded write of one message body file (tmp + rename). */
export async function writeMessageText(seq: number, text: string): Promise<void> {
  const dir = join(intercomBaseDir(), "messages");
  await mkdir(dir, { recursive: true });
  const final = messagePath(seq);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, final);
  } catch (error) {
    try { await rm(tmp, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

/** Read one message body file back (bounded to the write limit). */
export async function readMessageText(seq: number): Promise<string | null> {
  try {
    const path = messagePath(seq);
    const st = await stat(path);
    if (st.size > TEXT_LIMIT_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export interface LeaseFile {
  readonly holder: string;
  readonly acquiredAt: string;
}

export const LEASE_TTL_MS = 30 * 60 * 1000;

/** Read one advisory lease file; returns null when absent or unreadable. */
export async function readLease(cwd: string): Promise<LeaseFile | null> {
  try {
    const raw = await readFile(leasePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as { holder?: unknown; acquiredAt?: unknown };
    if (typeof parsed.holder !== "string" || typeof parsed.acquiredAt !== "string") return null;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(parsed.holder)) return null;
    if (Number.isNaN(Date.parse(parsed.acquiredAt))) return null;
    return { holder: parsed.holder, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

/** Advisory: true when the lease exists and is younger than the TTL. */
export function leaseValid(lease: LeaseFile): boolean {
  const age = Date.now() - Date.parse(lease.acquiredAt);
  return age >= 0 && age < LEASE_TTL_MS;
}

export async function writeLease(cwd: string, holder: string): Promise<void> {
  const dir = join(intercomBaseDir(), "leases");
  await mkdir(dir, { recursive: true });
  const lease: LeaseFile = { holder, acquiredAt: new Date().toISOString() };
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, `${JSON.stringify(lease)}\n`, "utf8");
    await rename(tmp, leasePath(cwd));
  } catch (error) {
    try { await rm(tmp, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

export async function removeLease(cwd: string): Promise<void> {
  await rm(leasePath(cwd), { force: true });
}

/** Canonical cwd key: realpath when resolvable, else the raw value. */
export function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}
