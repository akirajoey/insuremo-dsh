import { createHash } from "node:crypto";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AssetEntry, AssetType, JoinStatus } from "./types.ts";

const META_LIMIT = 256 * 1024;
const GROOVY_LIMIT = 2 * 1024 * 1024;
const MAX_ASSETS = 5000;
const BATCH_DEPTH_MAX = 6;
const ASSET_TYPES: AssetType[] = ["api", "function", "batch", "model"];

interface RawMeta {
  name: string;
  path?: string;
  id?: number;
  groupId?: number;
  moduleId?: number;
  version?: number;
  status?: number;
  requestMethod?: number;
  requestType?: number;
  appName?: string;
  md5Value?: string;
  latestUpdateTime?: string;
  jobName?: string;
  recordUsage?: string;
  sourceEnvironment?: string;
}

interface MetaItem {
  meta: RawMeta;
  type: AssetType;
  tenant?: string;
  group?: string;
}

interface Source {
  path: string;
  fingerprint: string;
  tenant: string;
  group: string;
}

const COMMON_KEYS = ["Path", "Id", "GroupId", "ModuleId", "Version", "Status", "RequestMethod", "RequestType", "AppName", "Md5Value", "LatestUpdateTime"];
const BATCH_KEYS = ["JobName", "RecordUsage", "_IComposerSourceEnvironment"];

function isContained(realPath: string, canonicalRoot: string): boolean {
  return realPath === canonicalRoot || realPath.startsWith(canonicalRoot + "/");
}

async function safeRealpath(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

async function readBoundedJson(file: string, canonicalRoot: string): Promise<{ raw: unknown } | { skip: "escape" | "invalid" }> {
  const real = await safeRealpath(file);
  if (!real || !isContained(real, canonicalRoot)) return { skip: "escape" };
  try {
    const st = await stat(real);
    if (st.size > META_LIMIT) return { skip: "invalid" };
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > META_LIMIT) return { skip: "invalid" };
    return { raw: JSON.parse(text) };
  } catch {
    return { skip: "invalid" };
  }
}

function projectMeta(raw: unknown, type: AssetType): RawMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = type === "batch" ? (raw as Record<string, unknown>)["batchJob"] : (raw as Record<string, unknown>)[type];
  if (typeof payload !== "object" || payload === null) return null;
  const r = payload as Record<string, unknown>;
  const name = typeof r.Name === "string" && r.Name ? r.Name : typeof r.BatchName === "string" && r.BatchName ? r.BatchName : "";
  if (!name) return null;
  const out: RawMeta = { name };
  const pick = (k: string, v: unknown) => {
    if (k === "Path" && typeof v === "string") out.path = v;
    else if (k === "Id" && typeof v === "number") out.id = v;
    else if (k === "GroupId" && typeof v === "number") out.groupId = v;
    else if (k === "ModuleId" && typeof v === "number") out.moduleId = v;
    else if (k === "Version" && typeof v === "number") out.version = v;
    else if (k === "Status" && typeof v === "number") out.status = v;
    else if (k === "RequestMethod" && typeof v === "number") out.requestMethod = v;
    else if (k === "RequestType" && typeof v === "number") out.requestType = v;
    else if (k === "AppName" && typeof v === "string") out.appName = v;
    else if (k === "Md5Value" && typeof v === "string") out.md5Value = v;
    else if (k === "LatestUpdateTime" && typeof v === "string") out.latestUpdateTime = v;
    else if (k === "JobName" && typeof v === "string") out.jobName = v;
    else if (k === "RecordUsage" && typeof v === "string") out.recordUsage = v;
    else if (k === "_IComposerSourceEnvironment" && typeof v === "string") out.sourceEnvironment = v;
  };
  for (const k of COMMON_KEYS) pick(k, r[k]);
  if (type === "batch") for (const k of BATCH_KEYS) pick(k, r[k]);
  return out;
}

async function collectTopLevelMeta(dir: string, type: AssetType, canonicalRoot: string, signal: AbortSignal | undefined, skipped: { n: number }): Promise<MetaItem[]> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return []; }
  const out: MetaItem[] = [];
  for (const file of files) {
    if (signal?.aborted) return out;
    if (!file.endsWith(".metadata.json")) continue;
    const res = await readBoundedJson(join(dir, file), canonicalRoot);
    if ("skip" in res) { skipped.n += 1; continue; }
    const meta = projectMeta(res.raw, type);
    if (!meta) { skipped.n += 1; continue; }
    out.push({ meta, type });
  }
  return out;
}

async function collectBatchMeta(dir: string, canonicalRoot: string, signal: AbortSignal | undefined, depth: number, skipped: { n: number }): Promise<MetaItem[]> {
  if (depth > BATCH_DEPTH_MAX) return [];
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: MetaItem[] = [];
  for (const name of names) {
    if (signal?.aborted) return out;
    const full = join(dir, name);
    if (name === "batch.metadata.json") {
      const res = await readBoundedJson(full, canonicalRoot);
      if ("skip" in res) { skipped.n += 1; continue; }
      const meta = projectMeta(res.raw, "batch");
      if (!meta) { skipped.n += 1; continue; }
      const segs = relative(canonicalRoot, dirname(full)).split("/");
      out.push({
        meta,
        type: "batch",
        tenant: segs.length >= 4 ? segs[2] : undefined,
        group: segs.length >= 5 ? segs[3] : undefined,
      });
      continue;
    }
    out.push(...(await collectBatchMeta(full, canonicalRoot, signal, depth + 1, skipped)));
  }
  return out;
}

async function fingerprintGroovy(real: string, canonicalRoot: string): Promise<Source | null> {
  if (!real || !isContained(real, canonicalRoot)) return null;
  const st = await stat(real);
  if (st.size > GROOVY_LIMIT) return null;
  const content = await readFile(real, "utf8");
  if (Buffer.byteLength(content) > GROOVY_LIMIT) return null;
  return { path: real, fingerprint: createHash("sha256").update(content).digest("hex"), tenant: "", group: "" };
}

function collectSourcesMap(out: Map<string, Source>, canonicalRoot: string, type: "api" | "function", signal?: AbortSignal): Promise<void> {
  return (async () => {
    const base = join(canonicalRoot, "src", "dev");
    let tenants: string[] = [];
    try { tenants = await readdir(base); } catch { return; }
    for (const tenant of tenants) {
      if (signal?.aborted) return;
      let groups: string[] = [];
      try { groups = await readdir(join(base, tenant)); } catch { continue; }
      for (const group of groups) {
        if (signal?.aborted) return;
        let names: string[] = [];
        try { names = await readdir(join(base, tenant, group, type)); } catch { continue; }
        for (const name of names) {
          const real = await safeRealpath(join(base, tenant, group, type, name, `${name}.groovy`));
          if (!real) continue;
          try {
            const fp = await fingerprintGroovy(real, canonicalRoot);
            if (fp) out.set(`${type}:${name}`, { ...fp, tenant, group });
          } catch { continue; }
        }
      }
    }
  })();
}

async function collectBatchSource(canonicalRoot: string, item: MetaItem, signal?: AbortSignal): Promise<Source | null> {
  const { meta, tenant, group } = item;
  if (!tenant || !group) return null;
  const base = join(canonicalRoot, "src", "dev", tenant, group, "batch", meta.name);
  let stepDirs: string[] = [];
  try { stepDirs = await readdir(base); } catch { return null; }
  for (const stepDir of stepDirs) {
    if (signal?.aborted) return null;
    const stepBase = join(base, stepDir);
    const realDir = await safeRealpath(stepBase);
    if (!realDir || !isContained(realDir, canonicalRoot)) continue;
    let files: string[] = [];
    try { files = await readdir(stepBase); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".groovy")) continue;
      const real = await safeRealpath(join(stepBase, f));
      if (!real) continue;
      try {
        const fp = await fingerprintGroovy(real, canonicalRoot);
        if (fp) return { ...fp, tenant, group };
      } catch { continue; }
    }
  }
  return null;
}

function md5OfFile(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export interface ScanResult {
  entries: AssetEntry[];
  truncated: boolean;
  sections: Record<AssetType, { status: "ok" | "missing" | "error"; skipped?: number }>;
}

export async function scanWorkspace(canonicalRootInput: string, filterType?: AssetType, signal?: AbortSignal): Promise<ScanResult> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const types = filterType ? [filterType] : ASSET_TYPES;
  const sections: Record<AssetType, { status: "ok" | "missing" | "error"; skipped?: number }> = {
    api: { status: "ok" }, function: { status: "ok" }, batch: { status: "ok" }, model: { status: "ok" },
  };
  let truncated = false;
  const metaItems: MetaItem[] = [];

  for (const type of types) {
    if (signal?.aborted) break;
    const skipped = { n: 0 };
    const base = join(canonicalRoot, ".metadata", type);
    let items: MetaItem[] = [];
    try {
      items = type === "batch"
        ? await collectBatchMeta(base, canonicalRoot, signal, 0, skipped)
        : await collectTopLevelMeta(base, type, canonicalRoot, signal, skipped);
    } catch {
      sections[type] = { status: "error" };
      continue;
    }
    if (items.length === 0 && skipped.n === 0) sections[type] = { status: "missing" };
    else if (skipped.n) sections[type] = { status: "ok", skipped: skipped.n };
    metaItems.push(...items);
  }

  const byKey = new Map<string, AssetEntry>();
  for (const item of metaItems) {
    if (signal?.aborted) break;
    if (byKey.size >= MAX_ASSETS) { truncated = true; break; }
    const { meta, type, tenant, group } = item;
    byKey.set(`${type}:${meta.name}`, {
      name: meta.name,
      type,
      metadata: {
        id: meta.id, groupId: meta.groupId, moduleId: meta.moduleId, version: meta.version, status: meta.status,
        requestMethod: meta.requestMethod, requestType: meta.requestType, appName: meta.appName,
        md5Value: meta.md5Value, latestUpdateTime: meta.latestUpdateTime,
        jobName: meta.jobName, recordUsage: meta.recordUsage, sourceEnvironment: meta.sourceEnvironment,
      },
      ...(tenant ? { tenant } : {}),
      ...(group ? { group } : {}),
      joinStatus: "source-missing",
    });
  }

  // source discovery (api/function/indexed + batch per meta item)
  const sourceMap = new Map<string, Source>();
  const wantApiFn = !filterType || filterType === "api" || filterType === "function";
  if (wantApiFn) {
    await Promise.all([
      collectSourcesMap(sourceMap, canonicalRoot, "api", signal),
      collectSourcesMap(sourceMap, canonicalRoot, "function", signal),
    ]);
  }
  const anyBatch = !filterType || filterType === "batch";
  const batchSources = new Map<string, Source>();
  if (anyBatch) {
    for (const item of metaItems.filter(m => m.type === "batch")) {
      if (signal?.aborted) break;
      const src = await collectBatchSource(canonicalRoot, item, signal);
      if (src) batchSources.set(`batch:${item.meta.name}`, src);
    }
  }

  for (const [key, src] of sourceMap) {
    const existing = byKey.get(key);
    const sep = key.indexOf(":");
    const type = key.slice(0, sep) as AssetType;
    const name = key.slice(sep + 1);
    if (existing) {
      byKey.set(key, await joinEntry(existing, src));
    } else if (byKey.size < MAX_ASSETS) {
      byKey.set(key, {
        name, type, metadata: {}, joinStatus: "metadata-missing",
        tenant: src.tenant, group: src.group, sourcePath: src.path, sourceFingerprint: src.fingerprint,
      });
    }
  }
  for (const [key, src] of batchSources) {
    const existing = byKey.get(key);
    if (existing) byKey.set(key, await joinEntry(existing, src));
  }

  if (signal?.aborted) return { entries: [], truncated: false, sections };
  const sorted = [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  if (sorted.length > MAX_ASSETS) {
    sorted.length = MAX_ASSETS;
    truncated = true;
  }
  return { entries: sorted, truncated, sections };
}

async function joinEntry(entry: AssetEntry, src: Source): Promise<AssetEntry> {
  const serverMd5 = entry.metadata.md5Value;
  let joinStatus: JoinStatus;
  if (!serverMd5) {
    joinStatus = "no-server-md5";
  } else {
    try {
      const content = await readFile(src.path, "utf8");
      joinStatus = md5OfFile(content) === serverMd5 ? "clean" : "local-modified";
    } catch {
      joinStatus = "local-modified";
    }
  }
  return {
    ...entry,
    sourcePath: src.path,
    sourceFingerprint: src.fingerprint,
    tenant: src.tenant || entry.tenant,
    group: src.group || entry.group,
    joinStatus,
  };
}
