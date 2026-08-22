import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetJoinState, TestKind } from "./types.ts";

const META_LIMIT = 256 * 1024;
const GROOVY_LIMIT = 2 * 1024 * 1024;

async function safeRealpath(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}
function isContained(realPath: string, root: string): boolean {
  return realPath === root || realPath.startsWith(root + "/");
}

async function readServerMd5(canonicalRoot: string, kind: TestKind, name: string): Promise<{ state: "found"; md5?: string } | { state: "missing" }> {
  const file = join(canonicalRoot, ".metadata", kind, `${name}.metadata.json`);
  const real = await safeRealpath(file);
  if (!real || !isContained(real, canonicalRoot)) return { state: "missing" };
  try {
    const st = await stat(real);
    if (st.size > META_LIMIT) return { state: "missing" };
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > META_LIMIT) return { state: "missing" };
    const raw = JSON.parse(text) as Record<string, unknown>;
    const payload = raw[kind] as Record<string, unknown> | undefined;
    if (typeof payload !== "object" || payload === null) return { state: "missing" };
    const md5 = typeof payload.Md5Value === "string" && payload.Md5Value ? payload.Md5Value : undefined;
    return { state: "found", ...(md5 ? { md5 } : {}) };
  } catch {
    return { state: "missing" };
  }
}

async function findLocalSource(canonicalRoot: string, kind: TestKind, name: string): Promise<string | null> {
  const base = join(canonicalRoot, "src", "dev");
  let tenants: string[] = [];
  try { tenants = await readdir(base); } catch { return null; }
  for (const tenant of tenants) {
    let groups: string[] = [];
    try { groups = await readdir(join(base, tenant)); } catch { continue; }
    for (const group of groups) {
      const real = await safeRealpath(join(base, tenant, group, kind, name, `${name}.groovy`));
      if (real && isContained(real, canonicalRoot)) return real;
    }
  }
  return null;
}

async function localMd5(real: string, canonicalRoot: string): Promise<string | null> {
  if (!isContained(real, canonicalRoot)) return null;
  try {
    const st = await stat(real);
    if (st.size > GROOVY_LIMIT) return null;
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > GROOVY_LIMIT) return null;
    return createHash("md5").update(text).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Join state for one api/function asset, mirroring the lifecycle reload
 * semantics: metadata md5 vs local groovy md5. `local-modified` means the
 * local file has unpushed changes relative to the last known server state.
 */
export async function assetJoinState(canonicalRootInput: string, kind: TestKind, name: string, signal?: AbortSignal): Promise<AssetJoinState> {
  if (signal?.aborted) return "source-missing";
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const local = await findLocalSource(canonicalRoot, kind, name);
  const meta = await readServerMd5(canonicalRoot, kind, name);
  if (meta.state === "missing") {
    return local === null ? "source-missing" : "metadata-missing";
  }
  if (local === null) return "source-missing";
  if (meta.md5 === undefined) return "no-server-md5";
  const md5 = await localMd5(local, canonicalRoot);
  if (md5 === null) return "source-missing";
  return md5 === meta.md5 ? "clean" : "local-modified";
}
