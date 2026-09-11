import { isSkillName } from "@deepseek-ai/dsh-skill";
import { SKILL_SCENARIOS, type SkillScenario } from "./types.ts";

/** The source alias is fixed by the product; it is never accepted from a request. */
export const SKILLS_TOOL_SOURCE = "insuremo-skills" as const;
/** Human-readable `add -l` output is bounded before it reaches this parser. */
export const SKILL_CATALOG_OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Keep the cache and every response finite even when a source grows unexpectedly. */
export const SKILL_CATALOG_MAX_ENTRIES = 128;
/**
 * Description bound. The real 1.1.2 macOS capture (`add -l`, 36 skills) measures
 * a maximum joined description of 1618 characters; the Windows capture wraps the
 * same descriptions as single long lines (14 rows above 500). 4096 keeps roughly
 * 2.5x headroom for longer future descriptions while staying bounded — an
 * over-limit description is still rejected (fail closed).
 */
export const SKILL_CATALOG_DESCRIPTION_MAX = 4096;
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
const ERASE_SEQUENCE = /^\u001B\[[0-9;]*[JK]/u;
const CURSOR_HOME = /^\u001B\[[0-9]*D/u;
/**
 * Assemble terminal output into logical lines.
 *
 * clack's spinner rewrites one visual line with `\r`/`ESC[<n>D` followed by
 * `ESC[K`/`ESC[J`; stripping those bytes would concatenate the erased spinner
 * text with the replacement text ("Found 36 skills" glued to the previous
 * fragment), so erasure INVALIDATES the pending visual line instead: the
 * carriage return resets it and an erase sequence drops it. A physical `\n`
 * terminates the logical line either way.
 */
export function assembleLogicalLines(output: string): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (char === "\r") {
      if (output[index + 1] === "\n") {
        lines.push(buffer);
        buffer = "";
        index += 1;
        continue;
      }
      buffer = "";
      continue;
    }
    if (char === "\n") {
      lines.push(buffer);
      buffer = "";
      continue;
    }
    if (char === "\u001B") {
      const rest = output.slice(index);
      const erase = ERASE_SEQUENCE.exec(rest) ?? CURSOR_HOME.exec(rest);
      if (erase !== null) {
        if (ERASE_SEQUENCE.test(erase[0])) buffer = "";
        index += erase[0].length - 1;
        continue;
      }
    }
    buffer += char;
  }
  if (buffer.length > 0) lines.push(buffer);
  return lines;
}
const MESSAGE_PREFIX = /^\s*([│|┃└┌├─])(\s{2,})/u;
const PREFIXES = /^(?:[┌└│|—]\s*|T(?=\s)\s*)/u;
const INDICATOR = /^[◇◆●•*oO0◒◐◓◑x>!▲■✔✓]\s{1,}/u;
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
  const lines = assembleLogicalLines(output).map(cleanLine);
  const markerIndexes = lines
    .map((line, index) => (lineText(line) === MARKER ? index : -1))
    .filter(index => index >= 0);
  if (markerIndexes.length !== 1) return { ok: false, reason: "format" };
  const markerIndex = markerIndexes[0]!;

  const footerIndexes = lines
    .map((line, index) => (messageOf(line)?.text === FOOTER ? index : -1))
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
  // log accidentally written to stdout must not be mistaken for a catalog,
  // and the clack ASCII logo is accepted only by its bounded glyph shape.
  for (const line of lines.slice(0, markerIndex)) {
    const text = lineText(line);
    if (text.length === 0) continue;
    if (!PREAMBLE_ALLOWED.some(pattern => pattern.test(text)) && !isLogoLine(text)) return { ok: false, reason: "format" };
  }

  for (const line of lines.slice(footerIndex + 1)) {
    if (lineText(line).length > 0) return { ok: false, reason: "format" };
  }

  const skills: SkillCatalogSkill[] = [];
  const names = new Set<string>();
  let currentGroup: string | undefined;
  let pendingName: string | undefined;
  let descriptionLines: string[] = [];
  let sawFooter = false;

  // Finish the pending row, if any. A name without a description is malformed,
  // and so is a description that is empty/oversized/control-bearing after the
  // paragraph separators are trimmed.
  const flushSkill = (): boolean => {
    if (pendingName === undefined) return true;
    const description = descriptionLines.join("\n").trim();
    if (descriptionLines.length === 0 || !validDescription(description) || skills.length >= SKILL_CATALOG_MAX_ENTRIES) return false;
    names.add(pendingName);
    skills.push({
      type: "skill",
      name: pendingName,
      description,
      ...(currentGroup === undefined ? {} : { group: currentGroup }),
    });
    pendingName = undefined;
    descriptionLines = [];
    return true;
  };

  for (let index = markerIndex + 1; index <= footerIndex; index += 1) {
    const line = lines[index] ?? "";
    const text = lineText(line);
    if (text.length === 0) {
      // Separators inside a description are paragraph breaks; the trailing break
      // before the next group/name is trimmed by flushSkill().
      if (pendingName !== undefined) descriptionLines.push("");
      continue;
    }
    const message = messageOf(line);
    if (message !== undefined) {
      if (message.text === FOOTER) {
        if (!flushSkill()) return { ok: false, reason: "format" };
        sawFooter = true;
        continue;
      }
      if (sawFooter) return { ok: false, reason: "format" };
      if (message.text.length === 0) {
        if (pendingName !== undefined) descriptionLines.push("");
        continue;
      }
      // A name row is the only shape with the name indent AND a kebab name.
      // The real 1.1.2 stream also emits description continuations at the same
      // indent, so the name test is content-based as well as shape-based.
      if (message.indent === 4 && validSkillName(message.text)) {
        if (!flushSkill()) return { ok: false, reason: "format" };
        if (names.has(message.text)) return { ok: false, reason: "format" };
        pendingName = message.text;
        continue;
      }
      if (message.indent !== 2 && message.indent !== 4 && message.indent !== 6) return { ok: false, reason: "format" };
      if (pendingName === undefined) return { ok: false, reason: "format" };
      descriptionLines.push(message.text);
      continue;
    }
    // Only plain, bounded group headings are accepted between skills; a heading
    // completing a pending skill must still carry a valid description.
    if (sawFooter || !flushSkill() || !validGroup(text)) return { ok: false, reason: "format" };
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
  const lines = assembleLogicalLines(output).map(cleanLine);
  let foundStatus = 0;
  let foundDetail = 0;
  for (const line of lines) {
    const text = lineText(line);
    if (text.length === 0) continue;
    if (text === EMPTY_STATUS) { foundStatus += 1; continue; }
    if (text === EMPTY_DETAIL) { foundDetail += 1; continue; }
    if (!PREAMBLE_ALLOWED.some(pattern => pattern.test(text)) && !isLogoLine(text)) return false;
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

/** Return the clack message payload and its indent for the 1.1.2 decoration set. */
function messageOf(value: string): { readonly text: string; readonly indent: number } | undefined {
  const match = MESSAGE_PREFIX.exec(value);
  return match === null ? undefined : { text: value.slice(match[0].length).trim(), indent: match[2]!.length };
}

/**
 * Bounded clack ASCII-logo line: box-drawing/block glyphs and spaces only,
 * with a hard length bound. The real 1.1.2 logo is six such lines above the
 * `skills` badge; anything with other characters is not a logo line.
 */
const LOGO_GLYPHS = /^[\s\u2500-\u257F\u2580-\u259F]+$/u;
const LOGO_MAX_LENGTH = 200;
function isLogoLine(text: string): boolean {
  return text.length > 0 && text.length <= LOGO_MAX_LENGTH && /[^\s]/u.test(text) && LOGO_GLYPHS.test(text);
}

function validSkillName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SKILL_NAME_LENGTH && isSkillName(value);
}

function validDescription(value: string): boolean {
  return value.length > 0
    && value.length <= SKILL_CATALOG_DESCRIPTION_MAX
    // Newlines are the parser's own paragraph separators; other control chars reject.
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
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
