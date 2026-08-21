import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SdkClientSummary, SdkOperation, UtilMethod, UtilSummary } from "./types.ts";

export const SWAGGER_LIMIT = 8 * 1024 * 1024;
export const DOC_LIMIT = 1024 * 1024;
export const SUMMARY_MAX = 200;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
}
const METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "trace"] as const;

export function isContained(realPath: string, canonicalRoot: string): boolean {
  return realPath === canonicalRoot || realPath.startsWith(canonicalRoot + "/");
}

async function safeRealpath(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

async function readBoundedText(file: string, canonicalRoot: string, limit: number): Promise<{ text: string } | { skip: "escape" | "invalid" }> {
  const real = await safeRealpath(file);
  if (!real || !isContained(real, canonicalRoot)) return { skip: "escape" };
  try {
    const st = await stat(real);
    if (st.size > limit) return { skip: "invalid" };
    const text = await readFile(real, "utf8");
    if (Buffer.byteLength(text) > limit) return { skip: "invalid" };
    return { text };
  } catch {
    return { skip: "invalid" };
  }
}

function frozen<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

export interface SdkScan {
  clients: SdkClientSummary[];
  operations: SdkOperation[];
}

export async function scanSdk(canonicalRootInput: string, signal?: AbortSignal): Promise<SdkScan> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const base = join(canonicalRoot, "sdk");
  let names: string[] = [];
  try { names = await readdir(base); } catch { return { clients: [], operations: [] }; }
  const clients: SdkClientSummary[] = [];
  const operations: SdkOperation[] = [];
  for (const name of names) {
    if (signal?.aborted) break;
    const entryPath = join(base, name);
    let st;
    try { st = await stat(entryPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const client = name;
    const swaggerPath = join(base, client, `${client}_swagger.json`);
    const res = await readBoundedText(swaggerPath, canonicalRoot, SWAGGER_LIMIT);
    if ("skip" in res) {
      clients.push(frozen({ client, swaggerPath, operationCount: 0, status: res.skip === "escape" ? "skipped-escape" : "invalid" }));
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(res.text); } catch { clients.push(frozen({ client, swaggerPath, operationCount: 0, status: "invalid" })); continue; }
    const projected = projectSdk(raw, client);
    clients.push(frozen({ client, swaggerPath, operationCount: projected.operations.length, status: "ok" }));
    operations.push(...projected.operations);
  }
  return { clients, operations };
}

function projectSdk(raw: unknown, client: string): { operations: SdkOperation[]; skipped: number } {
  if (typeof raw !== "object" || raw === null) return { operations: [], skipped: 0 };
  const paths = (raw as Record<string, unknown>)["paths"];
  if (typeof paths !== "object" || paths === null) return { operations: [], skipped: 0 };
  const ops: SdkOperation[] = [];
  let skipped = 0;
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (typeof item !== "object" || item === null) continue;
    for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
      if (!(METHODS as readonly string[]).includes(method)) continue;
      if (typeof op !== "object" || op === null) continue;
      const operationId = (op as Record<string, unknown>)["operationId"];
      if (typeof operationId !== "string" || !operationId) { skipped += 1; continue; }
      const opObj = op as Record<string, unknown>;
      const tag = Array.isArray(opObj["tags"]) ? (opObj["tags"] as unknown[]).find(x => typeof x === "string") : undefined;
      const rawSummary = typeof opObj["summary"] === "string" ? (opObj["summary"] as string) : "";
      const rawTag = typeof tag === "string" ? tag : "";
      ops.push(frozen({
        client,
        method,
        path,
        operationId,
        ...(rawSummary ? { summary: clip(rawSummary, SUMMARY_MAX) } : {}),
        ...(rawTag ? { tag: clip(rawTag, SUMMARY_MAX) } : {}),
      }));
    }
  }
  return { operations: ops, skipped };
}

export interface UtilScan {
  utils: UtilSummary[];
  methods: UtilMethod[];
}

export async function scanUtils(canonicalRootInput: string, signal?: AbortSignal): Promise<UtilScan> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const base = join(canonicalRoot, "ref_doc");
  let files: string[] = [];
  try { files = await readdir(base); } catch { return { utils: [], methods: [] }; }
  const utils: UtilSummary[] = [];
  const methods: UtilMethod[] = [];
  for (const f of files) {
    if (signal?.aborted) break;
    if (!f.endsWith(".md")) continue;
    const util = f.slice(0, -3);
    const docPath = join(base, f);
    const res = await readBoundedText(docPath, canonicalRoot, DOC_LIMIT);
    if ("skip" in res) {
      utils.push(frozen({ util, docPath, methodCount: 0, status: "invalid" }));
      continue;
    }
    const names = extractMethods(res.text, util);
    utils.push(frozen({ util, docPath, methodCount: names.length, status: "ok" }));
    for (const name of names) methods.push(frozen({ util, method: name }));
  }
  return { utils, methods };
}

export function extractMethods(text: string, utilName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /^#{2}\s+(\S+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const heading = m[1] as string;
    if (heading === "Sample" || heading === utilName) continue;
    if (seen.has(heading)) continue;
    seen.add(heading);
    out.push(heading);
  }
  return out;
}

export function matchKeyword(haystack: string | undefined, keyword: string): boolean {
  if (!keyword) return true;
  if (haystack === undefined) return false;
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}
