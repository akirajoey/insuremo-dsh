import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { isSkillAbortError, throwIfSkillAborted } from "./skill-cancellation.ts";

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_FRONTMATTER_VALUE_BYTES = 4 * 1024;
const FRONTMATTER_METADATA_KEYS = new Set(["title", "version", "category", "tags", "license"]);
const CANONICAL_DESCRIPTION_MAX_BYTES = 4 * 1024;

export interface ParsedFrontmatter {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly description?: string;
  /** Canonical Harness opt-out marker; only true enables managed override policy. */
  readonly disableModelInvocation?: boolean;
  readonly whenToUse?: string;
  readonly invocation?: {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
  };
}

export interface ParsedDocument extends ParsedFrontmatter {
  readonly content: string;
}

export async function readFrontmatterPrefix(path: string, signal?: AbortSignal): Promise<ParsedFrontmatter & { readonly invalid: boolean; readonly canonicalInvalid?: boolean }> {
  throwIfSkillAborted(signal);
  let file: FileHandle | undefined;
  try {
    const details = await stat(path);
    throwIfSkillAborted(signal);
    if (!details.isFile() || details.size > MAX_SKILL_FILE_BYTES) return { invalid: true };
    file = await open(path, "r");
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      throwIfSkillAborted(signal);
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    throwIfSkillAborted(signal);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!text.startsWith("---")) return { invalid: false };
    const match = frontmatterMatch(text);
    if (match === undefined || Buffer.byteLength(match[0], "utf8") > MAX_FRONTMATTER_BYTES) return { invalid: true };
    const parsed = parseFrontmatter(match[1]);
    return parsed === undefined
      ? { invalid: true, ...(hasCanonicalPolicyKey(match[1]) ? { canonicalInvalid: true } : {}) }
      : { ...parsed, invalid: false };
  } catch (error) {
    if (isSkillAbortError(error)) throw error;
    return { invalid: true };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function readSkillDocument(path: string, signal?: AbortSignal): Promise<ParsedDocument | undefined> {
  throwIfSkillAborted(signal);
  try {
    const details = await stat(path);
    throwIfSkillAborted(signal);
    if (!details.isFile() || details.size > MAX_SKILL_FILE_BYTES) return undefined;
    const text = await readFile(path, "utf8");
    throwIfSkillAborted(signal);
    if (Buffer.byteLength(text, "utf8") > MAX_SKILL_FILE_BYTES) return undefined;
    if (!text.startsWith("---")) return { content: text };
    const match = frontmatterMatch(text);
    if (match === undefined || Buffer.byteLength(match[0], "utf8") > MAX_FRONTMATTER_BYTES) return undefined;
    const parsed = parseFrontmatter(match[1]);
    return parsed === undefined ? undefined : { ...parsed, content: text.slice(match[0].length) };
  } catch (error) {
    if (isSkillAbortError(error)) throw error;
    return undefined;
  }
}

function hasCanonicalPolicyKey(block: string): boolean {
  return /(?:^|\n)\s*(?:disable-model-invocation|user-invocable|description)\s*:/.test(block);
}

function frontmatterMatch(text: string): RegExpExecArray | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match === null ? undefined : match;
}

function parseFrontmatter(block: string): ParsedFrontmatter | undefined {
  try {
    const value: unknown = parseYaml(block, { schema: "core", merge: false, maxAliasCount: 0, prettyErrors: false });
    if (!isPlainRecord(value)) return undefined;
    const metadata: Record<string, string> = {};
    for (const key of FRONTMATTER_METADATA_KEYS) {
      const item = value[key];
      if (typeof item === "string" && Buffer.byteLength(item, "utf8") <= MAX_FRONTMATTER_VALUE_BYTES) metadata[key] = item;
    }
    const descriptionValue = value.description;
    if (descriptionValue !== undefined && (typeof descriptionValue !== "string" || Buffer.byteLength(descriptionValue, "utf8") > CANONICAL_DESCRIPTION_MAX_BYTES)) return undefined;
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    const hasDisableModel = Object.prototype.hasOwnProperty.call(value, "disable-model-invocation");
    const disableModel = value["disable-model-invocation"];
    if (hasDisableModel && typeof disableModel !== "boolean") return undefined;
    const hasUserInvocable = Object.prototype.hasOwnProperty.call(value, "user-invocable");
    const userInvocable = value["user-invocable"];
    if (hasUserInvocable && typeof userInvocable !== "boolean") return undefined;
    const whenToUse = typeof value.whenToUse === "string" && Buffer.byteLength(value.whenToUse, "utf8") <= MAX_FRONTMATTER_VALUE_BYTES
      ? value.whenToUse
      : undefined;
    const hasModel = Object.prototype.hasOwnProperty.call(value, "modelInvocable");
    const hasUser = Object.prototype.hasOwnProperty.call(value, "userInvocable");
    const model = value.modelInvocable;
    const user = value.userInvocable;
    if ((hasModel && typeof model !== "boolean") || (hasUser && typeof user !== "boolean")) return undefined;
    const invocation = hasDisableModel || hasUserInvocable || hasModel || hasUser
      ? Object.freeze({
        modelInvocable: hasDisableModel ? !(disableModel as boolean) : hasModel ? model as boolean : true,
        userInvocable: hasUserInvocable ? userInvocable as boolean : hasUser ? user as boolean : true,
      })
      : undefined;
    return {
      ...(Object.keys(metadata).length === 0 ? {} : { metadata: Object.freeze(metadata) }),
      ...(description === undefined ? {} : { description }),
      ...(disableModel === true ? { disableModelInvocation: true } : {}),
      ...(whenToUse === undefined ? {} : { whenToUse }),
      ...(invocation === undefined ? {} : { invocation }),
    };
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
