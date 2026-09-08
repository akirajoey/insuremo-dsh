import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { isSkillAbortError, throwIfSkillAborted } from "./skill-cancellation.ts";

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_FRONTMATTER_VALUE_BYTES = 4 * 1024;
const FRONTMATTER_METADATA_KEYS = new Set(["title", "version", "category", "tags", "license"]);
const CANONICAL_DESCRIPTION_MAX_BYTES = 4 * 1024;

/** Stable, redaction-safe reasons emitted by the canonical Skill.md loader. */
export type SkillDocumentIssueCode =
  | "skill-file-too-large"
  | "skill-file-unreadable"
  | "frontmatter-too-large"
  | "frontmatter-unclosed"
  | "frontmatter-yaml-invalid"
  | "frontmatter-root-invalid"
  | "frontmatter-field-type-invalid"
  | "frontmatter-field-too-large";

export interface SkillDocumentIssue {
  readonly code: SkillDocumentIssueCode;
  /** 1-based line in SKILL.md when the bounded parser can determine it. */
  readonly line?: number;
  /** True only when a canonical invocation/description field caused rejection. */
  readonly canonicalInvalid: boolean;
}

export interface SkillDocumentInspection {
  readonly invalid: boolean;
  readonly canonicalInvalid?: boolean;
  readonly frontmatter?: ParsedFrontmatter;
  readonly issue?: SkillDocumentIssue;
}

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

export async function inspectSkillDocument(path: string, signal?: AbortSignal): Promise<SkillDocumentInspection> {
  throwIfSkillAborted(signal);
  let file: FileHandle | undefined;
  try {
    const details = await stat(path);
    throwIfSkillAborted(signal);
    if (!details.isFile()) return invalidInspection({ code: "skill-file-unreadable", canonicalInvalid: false });
    if (details.size > MAX_SKILL_FILE_BYTES) return invalidInspection({ code: "skill-file-too-large", canonicalInvalid: false });
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
    return inspectFrontmatter(text, bytesRead >= buffer.length);
  } catch (error) {
    if (isSkillAbortError(error)) throw error;
    return invalidInspection({ code: "skill-file-unreadable", canonicalInvalid: false });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function readFrontmatterPrefix(path: string, signal?: AbortSignal): Promise<ParsedFrontmatter & { readonly invalid: boolean; readonly canonicalInvalid?: boolean }> {
  const inspection = await inspectSkillDocument(path, signal);
  if (inspection.invalid) {
    return {
      invalid: true,
      ...(inspection.canonicalInvalid === true ? { canonicalInvalid: true } : {}),
    };
  }
  return { ...inspection.frontmatter, invalid: false };
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
    const inspection = inspectFrontmatter(text);
    if (inspection.invalid) return undefined;
    const match = frontmatterMatch(text);
    return {
      ...inspection.frontmatter,
      content: match === undefined ? text : text.slice(match[0].length),
    };
  } catch (error) {
    if (isSkillAbortError(error)) throw error;
    return undefined;
  }
}

function hasCanonicalPolicyKey(block: string): boolean {
  return /(?:^|\n)\s*(?:description|disable-model-invocation|user-invocable|modelInvocable|userInvocable)\s*:/.test(block);
}

function invalidInspection(issue: SkillDocumentIssue): SkillDocumentInspection {
  return { invalid: true, canonicalInvalid: issue.canonicalInvalid, issue };
}

function inspectFrontmatter(text: string, prefixTruncated = false): SkillDocumentInspection {
  if (!text.startsWith("---")) return { invalid: false };
  const match = frontmatterMatch(text);
  if (match === undefined) {
    return invalidInspection({
      code: prefixTruncated ? "frontmatter-too-large" : "frontmatter-unclosed",
      ...(prefixTruncated ? {} : { line: 1 }),
      // The closing fence is unknown, so do not inspect arbitrary body text
      // for canonical keys; preserve the historical provider fallback.
      canonicalInvalid: false,
    });
  }
  if (Buffer.byteLength(match[0], "utf8") > MAX_FRONTMATTER_BYTES) {
    return invalidInspection({
      code: "frontmatter-too-large",
      line: 1,
      // The historical prefix reader returned invalid without the
      // canonical-key marker when the bounded fence itself was too large.
      canonicalInvalid: false,
    });
  }
  const parsed = parseFrontmatter(match[1]);
  return parsed.issue === undefined
    ? { invalid: false, ...(parsed.value === undefined ? {} : { frontmatter: parsed.value }) }
    : invalidInspection(parsed.issue);
}

function frontmatterMatch(text: string): RegExpExecArray | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match === null ? undefined : match;
}

interface ParsedFrontmatterResult {
  readonly value?: ParsedFrontmatter;
  readonly issue?: SkillDocumentIssue;
}

function parseFrontmatter(block: string): ParsedFrontmatterResult {
  try {
    const value: unknown = parseYaml(block, { schema: "core", merge: false, maxAliasCount: 0, prettyErrors: false });
    if (!isPlainRecord(value)) {
      return { issue: {
        code: "frontmatter-root-invalid",
        line: 2,
        canonicalInvalid: hasCanonicalPolicyKey(block),
      } };
    }
    const metadata: Record<string, string> = {};
    for (const key of FRONTMATTER_METADATA_KEYS) {
      const item = value[key];
      // Non-canonical metadata has always been best-effort. Preserve that
      // fallback instead of turning a harmless metadata shape into a loader
      // failure; only canonical fields below are schema-invalidating.
      if (typeof item === "string" && Buffer.byteLength(item, "utf8") <= MAX_FRONTMATTER_VALUE_BYTES) metadata[key] = item;
    }
    const descriptionValue = value.description;
    if (descriptionValue !== undefined && typeof descriptionValue !== "string") {
      return { issue: fieldIssue(block, "description", "frontmatter-field-type-invalid") };
    }
    if (typeof descriptionValue === "string" && Buffer.byteLength(descriptionValue, "utf8") > CANONICAL_DESCRIPTION_MAX_BYTES) {
      return { issue: fieldIssue(block, "description", "frontmatter-field-too-large") };
    }
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    const hasDisableModel = Object.prototype.hasOwnProperty.call(value, "disable-model-invocation");
    const disableModel = value["disable-model-invocation"];
    if (hasDisableModel && typeof disableModel !== "boolean") {
      return { issue: fieldIssue(block, "disable-model-invocation", "frontmatter-field-type-invalid") };
    }
    const hasUserInvocable = Object.prototype.hasOwnProperty.call(value, "user-invocable");
    const userInvocable = value["user-invocable"];
    if (hasUserInvocable && typeof userInvocable !== "boolean") {
      return { issue: fieldIssue(block, "user-invocable", "frontmatter-field-type-invalid") };
    }
    const whenToUse = typeof value.whenToUse === "string" && Buffer.byteLength(value.whenToUse, "utf8") <= MAX_FRONTMATTER_VALUE_BYTES
      ? value.whenToUse
      : undefined;
    const hasModel = Object.prototype.hasOwnProperty.call(value, "modelInvocable");
    const hasUser = Object.prototype.hasOwnProperty.call(value, "userInvocable");
    const model = value.modelInvocable;
    const user = value.userInvocable;
    if (hasModel && typeof model !== "boolean") {
      return { issue: fieldIssue(block, "modelInvocable", "frontmatter-field-type-invalid") };
    }
    if (hasUser && typeof user !== "boolean") {
      return { issue: fieldIssue(block, "userInvocable", "frontmatter-field-type-invalid") };
    }
    const invocation = hasDisableModel || hasUserInvocable || hasModel || hasUser
      ? Object.freeze({
        modelInvocable: hasDisableModel ? !(disableModel as boolean) : hasModel ? model as boolean : true,
        userInvocable: hasUserInvocable ? userInvocable as boolean : hasUser ? user as boolean : true,
      })
      : undefined;
    return { value: {
      ...(Object.keys(metadata).length === 0 ? {} : { metadata: Object.freeze(metadata) }),
      ...(description === undefined ? {} : { description }),
      ...(disableModel === true ? { disableModelInvocation: true } : {}),
      ...(whenToUse === undefined ? {} : { whenToUse }),
      ...(invocation === undefined ? {} : { invocation }),
    } };
  } catch (error) {
    const line = parserLine(error, block);
    return { issue: {
      code: "frontmatter-yaml-invalid",
      ...(line === undefined ? {} : { line }),
      canonicalInvalid: hasCanonicalPolicyKey(block),
    } };
  }
}

function fieldIssue(block: string, key: string, code: "frontmatter-field-type-invalid" | "frontmatter-field-too-large"): SkillDocumentIssue {
  return { code, line: lineForKey(block, key), canonicalInvalid: true };
}

function lineForKey(block: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s*:`, "m").exec(block);
  return match === null ? undefined : block.slice(0, match.index).split(/\r?\n/).length + 1;
}

function parserLine(error: unknown, block: string): number | undefined {
  const pos = (error as { readonly pos?: unknown })?.pos;
  if (!Array.isArray(pos) || typeof pos[0] !== "number" || pos[0] < 0) return undefined;
  return block.slice(0, pos[0]).split(/\r?\n/).length + 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
