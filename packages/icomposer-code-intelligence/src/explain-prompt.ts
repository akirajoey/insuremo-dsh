import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { explainBaseDir } from "./storage.ts";

/**
 * TASK-131: user-owned prompt overrides, cached inside the ici result tree.
 *
 * Two optional files under `<workspace>/.metadata/icomposer/ici/explain/prompt/`:
 *   system-prompt.md -> extends the child's system section
 *   instruction.md   -> replaces the first block of the initial message
 *
 * The path is fixed (no parameter, no traversal surface) and BOTH files are read fresh for every
 * child creation, so editing a file takes effect on the next job without restarting the Host.
 * A missing, empty, oversized, non-UTF-8 or unreadable file simply falls back to the built-in
 * default: a broken prompt file must never fail a job.
 */

export const EXPLAIN_PROMPT_DIR = "prompt" as const;
export const EXPLAIN_SYSTEM_PROMPT_FILE = "system-prompt.md" as const;
export const EXPLAIN_INSTRUCTION_FILE = "instruction.md" as const;
export const MAX_EXPLAIN_SYSTEM_PROMPT_BYTES = 16 * 1024;
export const MAX_EXPLAIN_INSTRUCTION_BYTES = 8 * 1024;

/** The placeholders a user template may use; every one is resolved before the text is used. */
export const EXPLAIN_PROMPT_PLACEHOLDERS = ["apiName", "apiId", "workspaceId", "referenceTarget", "prepareId"] as const;
export interface ExplainPromptVars { readonly apiName: string; readonly apiId: string; readonly workspaceId: string; readonly referenceTarget: string; readonly prepareId: string; }

/**
 * The contract block the engine appends AFTER any user system text. It restates the rules the user
 * may extend but never remove; the default (no override) section stays byte-identical to the
 * pre-TASK-131 text and does not need this block.
 */
export const EXPLAIN_SYSTEM_CONTRACT = [
  "Non-negotiable contract (cannot be overridden):",
  "- Only ici_explain_list, ici_explain_read and ici_explain_submit exist; never use absolute paths, shell, network or write tools.",
  "- Cite evidence only as relative path#N or path#N-M; # is mandatory and : or objects are never accepted.",
  "- ici_explain_submit is the ONLY completion boundary: technical (string), business (string), flow (string[]), evidence (string[]). A schema-invalid submit may be corrected up to three attempts.",
].join("\n");

/** The submit-boundary sentence appended after any user instruction text. */
export const EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY = "Finish by calling ici_explain_submit (technical string, business string, flow string[], evidence string[] with relative path#N or path#N-M); it is the only completion boundary and answer text alone is not accepted.";

/** Replace every known placeholder; an unknown placeholder is left untouched. */
export function renderExplainPromptTemplate(text: string, vars: ExplainPromptVars): string {
  return text.replace(/\{\{(apiName|apiId|workspaceId|referenceTarget|prepareId)\}\}/g, (_match, name: string) => vars[name as keyof ExplainPromptVars] ?? "");
}

/** Absolute path of one prompt override file (fixed location, never parameterized by the caller). */
export function explainPromptOverridePath(root: string, file: string): string { return join(explainBaseDir(root), EXPLAIN_PROMPT_DIR, file); }

/**
 * Read one override file. Returns the raw text when it is usable, or null when the caller must fall
 * back to the built-in default. Every failure mode (missing, empty/whitespace, oversize, invalid
 * UTF-8, unreadable) is swallowed on purpose: prompt customization is optional.
 */
export async function readExplainPromptOverride(root: string, file: string, maxBytes: number): Promise<string | null> {
  try {
    const raw = await readFile(explainPromptOverridePath(root, file));
    if (raw.byteLength === 0 || raw.byteLength > maxBytes) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

export interface ExplainPromptOverrides { readonly system: string | null; readonly instruction: string | null; }

/** Both overrides for one job, read fresh, with placeholders resolved. Never throws. */
export async function loadExplainPromptOverrides(root: string, vars: ExplainPromptVars): Promise<ExplainPromptOverrides> {
  const [system, instruction] = await Promise.all([
    readExplainPromptOverride(root, EXPLAIN_SYSTEM_PROMPT_FILE, MAX_EXPLAIN_SYSTEM_PROMPT_BYTES),
    readExplainPromptOverride(root, EXPLAIN_INSTRUCTION_FILE, MAX_EXPLAIN_INSTRUCTION_BYTES),
  ]);
  return {
    system: system === null ? null : `${renderExplainPromptTemplate(system, vars)}\n${EXPLAIN_SYSTEM_CONTRACT}`,
    instruction: instruction === null ? null : `${renderExplainPromptTemplate(instruction, vars)}\n${EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY}`,
  };
}
