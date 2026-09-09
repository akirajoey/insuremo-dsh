import { isSkillName } from "@deepseek-ai/dsh-skill";
import { SKILL_SCENARIOS, type SkillScenario } from "./types.ts";

/** The source alias is fixed by the product; it is never accepted from a request. */
export const SKILLS_TOOL_SOURCE = "insuremo-skills" as const;
/** Human-readable `add -l` output is bounded before it reaches this parser. */
export const SKILL_CATALOG_OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Keep the cache and every response finite even when a source grows unexpectedly. */
export const SKILL_CATALOG_MAX_ENTRIES = 128;
export const SKILL_CATALOG_DESCRIPTION_MAX = 500;
export const SKILL_CATALOG_TTL_MS = 60_000;
export const SKILL_CATALOG_TIMEOUT_MS = 15_000;
export const SKILL_CATALOG_SCHEMA_VERSION = "1" as const;

export interface SkillCatalogSkill {
  readonly type: "skill";
  readonly name: string;
  readonly description: string;
  readonly group?: string;
}

export interface SkillCatalogScenario {
  readonly type: "scenario";
  readonly name: SkillScenario;
  readonly description: string;
}

export type SkillCatalogEntry = SkillCatalogSkill | SkillCatalogScenario;

/** Safe, browser-facing catalog snapshot. It contains no source path or raw output. */
export interface SkillCatalogSnapshot {
  readonly schemaVersion: typeof SKILL_CATALOG_SCHEMA_VERSION;
  readonly status: "ready" | "empty";
  readonly source: typeof SKILLS_TOOL_SOURCE;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly entries: readonly SkillCatalogEntry[];
}

export interface ParsedSkillCatalog {
  readonly skills: readonly SkillCatalogSkill[];
  readonly foundCount: number;
}

export type CatalogParseResult =
  | { readonly ok: true; readonly value: ParsedSkillCatalog }
  | { readonly ok: false; readonly reason: "empty" | "format" | "oversized" };

const ANSI_ESCAPE = /\u001B(?:\](?:[^\u0007\u001B]|\u001B(?=\\))*\u0007|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Z])/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const MESSAGE_PREFIX = /^\s*[│|]\s{2,}/u;
const PREFIXES = /^(?:[┌└│|—]\s*|T(?=\s)\s*)/u;
const INDICATOR = /^[◇◆●•*oO0◒◐◓◑x>!▲■]\s{1,}/u;
const FOUND = /^Found\s+([0-9]{1,4})\s+skills?$/u;
const FOOTER = "Use --skill <name> to install specific skills";
const EMPTY_STATUS = "No skills found";
const EMPTY_DETAIL = "No valid skills found. Skills require a SKILL.md with name and description.";
const MARKER = "Available Skills";
const MAX_GROUP_LENGTH = 128;
const MAX_SKILL_NAME_LENGTH = 128;
const PREAMBLE_ALLOWED = [
  /^skills$/u,
  /^Tip: use the --yes \(-y\) and --global \(-g\) flags to install without prompts\.$/u,
  /^Parsing source\.\.\.$/u,
  /^Source:\s+https:\/\/gitlab\.insuremo\.com\/insuremo-public\/insuremo-skills\.git$/u,
  /^Validating local path\.\.\.$/u,
  /^Local path validated$/u,
  /^Fetching npm package from registry\.\.\.$/u,
  /^Fetching skills from npm registry\.\.\.$/u,
  /^Package resolved:\s+@insuremo\/skills@[A-Za-z0-9][A-Za-z0-9._+-]*$/u,
  /^Package resolved from local copy$/u,
  /^Registry fetch failed, looking for a local copy\.\.\.$/u,
  /^Syncing repository to store\.\.\.$/u,
  /^Repository synced$/u,
  /^Git host unreachable — using npm registry \(.+\)$/u,
  /^Git sync failed — falling back to npm registry \(.+\)$/u,
  /^Discovering skills\.\.\.$/u,
  FOUND,
];

/**
 * Parse the POC `@insuremo/skills-tool@1.1.2 add -l` stream.
 *
 * `add -l` has no machine-readable mode (the CLI's `list --json` is only the
 * installed inventory), so this parser deliberately accepts one known human
 * format and rejects every unknown shape. ANSI/cursor decoration emitted by
 * clack is removed, while arbitrary stdout logs are not silently skipped.
 */
export function parseSkillCatalogOutput(output: string): CatalogParseResult {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > SKILL_CATALOG_OUTPUT_LIMIT_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  const lines = output.replace(/\r\n?/gu, "\n").split("\n").map(cleanLine);
  const markerIndexes = lines
    .map((line, index) => (lineText(line) === MARKER ? index : -1))
    .filter(index => index >= 0);
  if (markerIndexes.length !== 1) return { ok: false, reason: "format" };
  const markerIndex = markerIndexes[0]!;

  const footerIndexes = lines
    .map((line, index) => (messageText(line) === FOOTER ? index : -1))
    .filter(index => index >= 0);
  if (footerIndexes.length !== 1 || footerIndexes[0]! <= markerIndex) return { ok: false, reason: "format" };
  const footerIndex = footerIndexes[0]!;

  // The count is emitted by the same CLI immediately before the list. It
  // makes a syntactically plausible but empty/truncated block unavailable.
  const found = lines
    .slice(0, markerIndex)
    .map(lineText)
    .map(value => FOUND.exec(value)?.[1])
    .filter((value): value is string => value !== undefined);
  if (found.length !== 1) return { ok: false, reason: "format" };
  const foundCount = Number(found[0]);
  if (!Number.isSafeInteger(foundCount) || foundCount < 0 || foundCount > SKILL_CATALOG_MAX_ENTRIES) {
    return { ok: false, reason: foundCount === 0 ? "empty" : "oversized" };
  }

  // Validate the part before the marker as well. In particular, an npm/git
  // log accidentally written to stdout must not be mistaken for a catalog.
  for (const line of lines.slice(0, markerIndex)) {
    const text = lineText(line);
    if (text.length === 0) continue;
    if (!PREAMBLE_ALLOWED.some(pattern => pattern.test(text))) return { ok: false, reason: "format" };
  }

  for (const line of lines.slice(footerIndex + 1)) {
    if (lineText(line).length > 0) return { ok: false, reason: "format" };
  }

  const skills: SkillCatalogSkill[] = [];
  const names = new Set<string>();
  let currentGroup: string | undefined;
  let pendingName: string | undefined;
  let sawFooter = false;

  for (let index = markerIndex + 1; index <= footerIndex; index += 1) {
    const line = lines[index] ?? "";
    const text = lineText(line);
    if (text.length === 0) continue;
    const message = messageText(line);
    if (message !== undefined) {
      if (message === FOOTER) {
        if (pendingName !== undefined) return { ok: false, reason: "format" };
        sawFooter = true;
        continue;
      }
      if (sawFooter) return { ok: false, reason: "format" };
      if (pendingName === undefined) {
        if (!validSkillName(message) || names.has(message)) return { ok: false, reason: "format" };
        pendingName = message;
      } else {
        if (!validDescription(message) || skills.length >= SKILL_CATALOG_MAX_ENTRIES) return { ok: false, reason: "format" };
        names.add(pendingName);
        skills.push({
          type: "skill",
          name: pendingName,
          description: message,
          ...(currentGroup === undefined ? {} : { group: currentGroup }),
        });
        pendingName = undefined;
      }
      continue;
    }
    // Only plain, bounded group headings are accepted between message pairs.
    // Any unknown prefixed/log line therefore fails closed instead of being
    // ignored as decoration.
    if (sawFooter || pendingName !== undefined || !validGroup(text)) return { ok: false, reason: "format" };
    currentGroup = text;
  }

  if (!sawFooter || pendingName !== undefined || skills.length !== foundCount) {
    return { ok: false, reason: skills.length === 0 ? "empty" : "format" };
  }
  return { ok: true, value: { skills: Object.freeze(skills), foundCount } };
}

/** Recognize only the documented 1.1.2 empty-source failure envelope. */
export function isEmptySkillCatalogOutput(output: string): boolean {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > SKILL_CATALOG_OUTPUT_LIMIT_BYTES) return false;
  const lines = output.replace(/\r\n?/gu, "\n").split("\n").map(cleanLine);
  let foundStatus = 0;
  let foundDetail = 0;
  for (const line of lines) {
    const text = lineText(line);
    if (text.length === 0) continue;
    if (text === EMPTY_STATUS) { foundStatus += 1; continue; }
    if (text === EMPTY_DETAIL) { foundDetail += 1; continue; }
    if (!PREAMBLE_ALLOWED.some(pattern => pattern.test(text))) return false;
  }
  return foundStatus === 1 && foundDetail === 1;
}

/** Alias kept short for callers that do not need the implementation detail. */
export const parseCatalogOutput = parseSkillCatalogOutput;

/** Add the fixed, server-owned scenario choices to a successfully parsed source catalog. */
export function buildSkillCatalog(
  parsed: ParsedSkillCatalog,
  now = Date.now(),
  ttlMs = SKILL_CATALOG_TTL_MS,
): SkillCatalogSnapshot {
  const safeTtl = Number.isFinite(ttlMs) ? Math.max(1, Math.min(ttlMs, 5 * 60_000)) : SKILL_CATALOG_TTL_MS;
  const scenarios: SkillCatalogScenario[] = SKILL_SCENARIOS.map(name => ({
    type: "scenario",
    name,
    description: scenarioDescription(name),
  }));
  const skills = [...parsed.skills].sort((left, right) => left.name.localeCompare(right.name));
  // Preserve the server-owned scenario order (full-stack first) so existing
  // first-install behavior remains stable; only source skill rows are sorted.
  const entries = [...scenarios, ...skills].map(entry => Object.freeze(entry));
  return Object.freeze({
    schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
    status: parsed.skills.length === 0 ? "empty" : "ready",
    source: SKILLS_TOOL_SOURCE,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + safeTtl).toISOString(),
    entries: Object.freeze(entries),
  });
}

export function catalogSkillNames(snapshot: SkillCatalogSnapshot): readonly string[] {
  return snapshot.entries
    .filter((entry): entry is SkillCatalogSkill => entry.type === "skill")
    .map(entry => entry.name);
}

function cleanLine(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(CONTROL, "");
}

/** Remove clack's line/symbol decoration without changing user-facing text. */
function lineText(value: string): string {
  let text = value.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(PREFIXES, "").replace(INDICATOR, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** Return payload text only for the exact clack message prefix used by 1.1.2. */
function messageText(value: string): string | undefined {
  const match = MESSAGE_PREFIX.exec(value);
  return match === null ? undefined : value.slice(match[0].length).trim();
}

function validSkillName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SKILL_NAME_LENGTH && isSkillName(value);
}

function validDescription(value: string): boolean {
  return value.length > 0
    && value.length <= SKILL_CATALOG_DESCRIPTION_MAX
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function validGroup(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_GROUP_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9 _-]*$/u.test(value);
}

function scenarioDescription(name: SkillScenario): string {
  const descriptions: Record<SkillScenario, string> = {
    "icomposer-full-stack": "完整 iComposer 开发工具包（设计、编码、部署、搜索与配置）",
    "icomposer-coding-lite": "轻量 iComposer 开发工具包（编码与部署）",
    "icomposer-api-design": "API 设计与研究工具包",
    "uic-developer": "UI Connector 开发工具包",
    "ask-insuremo": "InsureMO 知识搜索工具包",
  };
  return descriptions[name];
}
