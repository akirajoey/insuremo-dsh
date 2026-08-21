import { createHash } from "node:crypto";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AssetType, JoinSample, ReloadPreviewView } from "./types.ts";

const META_LIMIT = 256 * 1024;
const GROOVY_LIMIT = 2 * 1024 * 1024;
const BATCH_DEPTH_MAX = 6;
const TOP_MAX = 50;
const ASSET_TYPES: AssetType[] = ["api", "function", "batch", "model"];

type JoinStatus = "clean" | "local-modified" | "no-server-md5" | "source-missing" | "metadata-missing";

export interface ReloadPreviewScan {
  readonly distribution: ReloadPreviewView["distribution"];
  readonly total: number;
  readonly top: JoinSample[];
}

function isContained(realPath: string, canonicalRoot: string): boolean {
  return realPath === canonicalRoot || realPath.startsWith(canonicalRoot + "/");
}

async function safeRealpath(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

async function readBoundedJson(file: string, canonicalRoot: string): Promise<{ raw: unknown } | { skip: boolean }> {
  const real = await safeRealpath(file);
  if (!real || !isContained(real, canonicalRoot)) return { skip: true };
  try {
    const st = await stat(real);
    if (st.size > META_LIMIT) return { skip: true };
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > META_LIMIT) return { skip: true };
    return { raw: JSON.parse(text) };
  } catch {
    return { skip: true };
  }
}

interface MetaItem {
  name: string;
  type: AssetType;
  md5?: string;
  tenant?: string;
  group?: string;
}

function projectMeta(raw: unknown, type: AssetType): { name: string; md5?: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = type === "batch" ? (raw as Record<string, unknown>)["batchJob"] : (raw as Record<string, unknown>)[type];
  if (typeof payload !== "object" || payload === null) return null;
  const r = payload as Record<string, unknown>;
  const name = typeof r.Name === "string" && r.Name ? r.Name : typeof r.BatchName === "string" && r.BatchName ? r.BatchName : "";
  if (!name) return null;
  const md5 = typeof r.Md5Value === "string" && r.Md5Value ? r.Md5Value : undefined;
  return { name, ...(md5 ? { md5 } : {}) };
}

async function collectTopLevelMeta(dir: string, type: AssetType, canonicalRoot: string, signal?: AbortSignal): Promise<MetaItem[]> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return []; }
  const out: MetaItem[] = [];
  for (const file of files) {
    if (signal?.aborted) return out;
    if (!file.endsWith(".metadata.json")) continue;
    const res = await readBoundedJson(join(dir, file), canonicalRoot);
    if ("skip" in res) continue;
    const meta = projectMeta(res.raw, type);
    if (meta) out.push({ ...meta, type });
  }
  return out;
}

async function collectBatchMeta(dir: string, canonicalRoot: string, signal?: AbortSignal, depth = 0): Promise<MetaItem[]> {
  if (depth > BATCH_DEPTH_MAX) return [];
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: MetaItem[] = [];
  for (const name of names) {
    if (signal?.aborted) return out;
    const full = join(dir, name);
    if (name === "batch.metadata.json") {
      const res = await readBoundedJson(full, canonicalRoot);
      if ("skip" in res) continue;
      const meta = projectMeta(res.raw, "batch");
      if (!meta) continue;
      const segs = relative(canonicalRoot, dirname(full)).split("/");
      out.push({ ...meta, type: "batch", tenant: segs.length >= 4 ? segs[2] : undefined, group: segs.length >= 5 ? segs[3] : undefined });
      continue;
    }
    out.push(...(await collectBatchMeta(full, canonicalRoot, signal, depth + 1)));
  }
  return out;
}

async function findApiFunctionSource(canonicalRoot: string, type: "api" | "function", name: string): Promise<string | null> {
  const base = join(canonicalRoot, "src", "dev");
  let tenants: string[] = [];
  try { tenants = await readdir(base); } catch { return null; }
  for (const tenant of tenants) {
    let groups: string[] = [];
    try { groups = await readdir(join(base, tenant)); } catch { continue; }
    for (const group of groups) {
      const real = await safeRealpath(join(base, tenant, group, type, name, `${name}.groovy`));
      if (!real || !isContained(real, canonicalRoot)) continue;
      return real;
    }
  }
  return null;
}

async function findBatchSource(canonicalRoot: string, item: MetaItem): Promise<string | null> {
  const { tenant, group, name } = item;
  if (!tenant || !group) return null;
  const base = join(canonicalRoot, "src", "dev", tenant, group, "batch", name);
  let stepDirs: string[] = [];
  try { stepDirs = await readdir(base); } catch { return null; }
  for (const stepDir of stepDirs) {
    const stepBase = join(base, stepDir);
    const realDir = await safeRealpath(stepBase);
    if (!realDir || !isContained(realDir, canonicalRoot)) continue;
    let files: string[] = [];
    try { files = await readdir(stepBase); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".groovy")) continue;
      const real = await safeRealpath(join(stepBase, f));
      if (!real || !isContained(real, canonicalRoot)) continue;
      return real;
    }
  }
  return null;
}

async function groovyContents(real: string, canonicalRoot: string): Promise<string | null> {
  if (!isContained(real, canonicalRoot)) return null;
  try {
    const st = await stat(real);
    if (st.size > GROOVY_LIMIT) return null;
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > GROOVY_LIMIT) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Local reload pre-check: computes the local join-status distribution of a
 * workspace asset tree (mirrors the catalog join semantics) without invoking
 * any mutating flow. Real `imo icomposer reload` is deferred to Phase 5.
 */
export async function scanReloadPreview(canonicalRootInput: string, signal?: AbortSignal): Promise<ReloadPreviewScan> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const metaItems: MetaItem[] = [];
  for (const type of ASSET_TYPES) {
    if (signal?.aborted) break;
    const base = join(canonicalRoot, ".metadata", type);
    metaItems.push(...(type === "batch"
      ? await collectBatchMeta(base, canonicalRoot, signal)
      : await collectTopLevelMeta(base, type, canonicalRoot, signal)));
  }

  const distribution = { clean: 0, localModified: 0, noServerMd5: 0, sourceMissing: 0, metadataMissing: 0 };
  let total = 0;
  const top: JoinSample[] = [];

  const seen = new Set<string>();
  const pushEntry = (sample: JoinSample): void => {
    if (top.length < TOP_MAX) top.push(sample);
  };

  // metadata-first entries
  for (const item of metaItems) {
    if (signal?.aborted) break;
    const key = `${item.type}:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;
    let real: string | null = null;
    if (item.type === "batch") real = await findBatchSource(canonicalRoot, item);
    else if (item.type === "api" || item.type === "function") real = await findApiFunctionSource(canonicalRoot, item.type, item.name);
    if (real === null) {
      distribution.sourceMissing += 1;
      pushEntry({ name: item.name, type: item.type });
      continue;
    }
    const content = await groovyContents(real, canonicalRoot);
    if (content === null) {
      distribution.sourceMissing += 1;
      pushEntry({ name: item.name, type: item.type });
      continue;
    }
    if (!item.md5) {
      distribution.noServerMd5 += 1;
      pushEntry({ name: item.name, type: item.type });
      continue;
    }
    const md5 = createHash("md5").update(content).digest("hex");
    if (md5 === item.md5) distribution.clean += 1;
    else distribution.localModified += 1;
    pushEntry({ name: item.name, type: item.type });
  }

  // source-only entries (metadata-missing)
  if (!signal?.aborted) {
    const sources: Array<[AssetType, string]> = [
      ...(await collectApiFunctionNames(canonicalRoot, "api", signal)),
      ...(await collectApiFunctionNames(canonicalRoot, "function", signal)),
    ];
    if (!signal?.aborted) {
      for (const [type, name] of sources) {
        const key = `${type}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += 1;
        distribution.metadataMissing += 1;
        pushEntry({ name, type });
      }
    }
  }

  return { distribution, total, top };
}

async function collectApiFunctionNames(canonicalRoot: string, type: "api" | "function", signal?: AbortSignal): Promise<Array<[AssetType, string]>> {
  const out: Array<[AssetType, string]> = [];
  const base = join(canonicalRoot, "src", "dev");
  let tenants: string[] = [];
  try { tenants = await readdir(base); } catch { return out; }
  for (const tenant of tenants) {
    if (signal?.aborted) break;
    let groups: string[] = [];
    try { groups = await readdir(join(base, tenant)); } catch { continue; }
    for (const group of groups) {
      let names: string[] = [];
      try { names = await readdir(join(base, tenant, group, type)); } catch { continue; }
      for (const name of names) {
        const real = await safeRealpath(join(base, tenant, group, type, name, `${name}.groovy`));
        if (real && isContained(real, canonicalRoot)) out.push([type, name]);
      }
    }
  }
  return out;
}
