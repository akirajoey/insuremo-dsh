import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "./config.ts";
import { mapRunFailure, runCapture, type ImoResult } from "./run.ts";
import {
  isSkillAbortError,
  throwIfSkillAborted,
} from "./skill-cancellation.ts";
import { resolveAllowedSkillRoot, resolveSkillPath } from "./skill-path.ts";
import { inspectSkillDocument, type SkillDocumentIssue } from "./skill-document.ts";

// ---- IMO Skills inventory (read-only) ----

/** Scope of an `imo skills list` query. */
export type ImoSkillScope = "project" | "global";

/** One skill row exactly as `imo skills list --json` reports it. */
export interface ImoSkillEntry {
  readonly name: string;
  readonly description: string;
  /** Path as reported by imo (may be `./`-relative to the user home). */
  readonly path: string;
}

export interface ImoSkillList {
  readonly scope: ImoSkillScope;
  readonly skills: readonly ImoSkillEntry[];
  readonly stdoutDigest: string;
}

export interface ImoSkillConfigPath {
  readonly path: string;
  readonly exists: boolean;
}

export interface ImoSkillValidationDiagnostic {
  /** Stable, redaction-safe code from the canonical loader/path resolver. */
  readonly code: string;
  /** 1-based SKILL.md line only when it is reliable and safe to expose. */
  readonly line?: number;
  /** Canonical frontmatter rejection keeps provider fallback behavior explicit. */
  readonly canonicalInvalid?: boolean;
}

export interface ImoSkillValidationItem {
  readonly name: string;
  readonly description: string;
  /** Absolute path used internally for validation; overview never exposes it. */
  readonly path: string;
  readonly valid: boolean;
  readonly reasons: readonly string[];
  /** Present only for a bounded, sanitized diagnostic. */
  readonly diagnostic?: ImoSkillValidationDiagnostic;
}

export interface ImoSkillValidation {
  readonly scope: ImoSkillScope;
  readonly inventoryComplete: boolean;
  readonly items: readonly ImoSkillValidationItem[];
  readonly checkedAt: string;
}

/** Emitted after a successful `imo skills list` finishes. */
export const SKILLS_INVENTORY_UPDATED_EVENT = "skills/inventory-updated" as const;

/** Public read-only skills face provided as `ctx.imoSkills`. */
export interface ImoSkills {
  list(scope?: ImoSkillScope, signal?: AbortSignal): Promise<ImoResult<ImoSkillList>>;
  configPath(signal?: AbortSignal): Promise<ImoResult<ImoSkillConfigPath>>;
  validate(scope?: ImoSkillScope, signal?: AbortSignal): Promise<ImoResult<ImoSkillValidation>>;
}

/** Read-only IMO Skills inventory service. All process operations route through `ctx.subprocess`. */
export class ImoSkillsService extends Service implements ImoSkills {
  static inject = ["subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;
  /** Root used by the internal path resolver; defaults to homedir(). */
  readonly skillsAllowedRoot: string;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoSkills");
    this.config = resolveConfig(config);
    this.skillsAllowedRoot = homedir();
  }

  async list(scope: ImoSkillScope = "project", signal?: AbortSignal): Promise<ImoResult<ImoSkillList>> {
    const args = scope === "global" ? ["skills", "list", "--json", "-g"] : ["skills", "list", "--json"];
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return run.error.code === "cancelled"
      ? cancelledSkillsResult(this.config.command, args)
      : { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return parseSkillsError(run, this.config.command, args, "skills list output was not valid JSON");
    }
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    if (!Array.isArray(parsed)) {
      return parseSkillsError(run, this.config.command, args, "skills list JSON was not an array");
    }
    const skills: ImoSkillEntry[] = parsed.map((row) => {
      const entry = typeof row === "object" && row !== null ? row as Record<string, unknown> : {};
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        description: typeof entry.description === "string" ? entry.description : "",
        path: typeof entry.path === "string" ? entry.path : "",
      };
    });
    // Coercion keeps parity with `imo skills list --json`; a malformed row
    // surfaces through validate() instead of crashing the list.
    const stdoutDigest = run.value.stdoutDigest;
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    this.ctx.emit(SKILLS_INVENTORY_UPDATED_EVENT, { scope, skills: [...skills], stdoutDigest });
    return { ok: true, value: { scope, skills, stdoutDigest } };
  }

  async configPath(signal?: AbortSignal): Promise<ImoResult<ImoSkillConfigPath>> {
    const args = ["skills", "config", "path"] as const;
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return run.error.code === "cancelled"
      ? cancelledSkillsResult(this.config.command, args)
      : { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    const path = run.value.stdout.text.split(/\r?\n/)[0]?.trim() ?? "";
    let exists = false;
    try {
      exists = (await stat(path)).isFile();
    } catch {
      exists = false; // an absent config file must not crash the read
    }
    if (signal?.aborted) return cancelledSkillsResult(this.config.command, args);
    return { ok: true, value: { path, exists } };
  }

  async validate(scope: ImoSkillScope = "project", signal?: AbortSignal): Promise<ImoResult<ImoSkillValidation>> {
    const args = scope === "global" ? ["skills", "list", "--json", "-g"] : ["skills", "list", "--json"];
    try {
      throwIfSkillAborted(signal);
      const listResult = await this.list(scope, signal);
      if (!listResult.ok) return listResult;
      throwIfSkillAborted(signal);
      const allowedRoot = await resolveAllowedSkillRoot(this.skillsAllowedRoot);
      throwIfSkillAborted(signal);
      const items: ImoSkillValidationItem[] = [];
      for (const skill of listResult.value.skills) {
        throwIfSkillAborted(signal);
        const resolved = await resolveSkillPath(skill.path, this.skillsAllowedRoot, allowedRoot);
        throwIfSkillAborted(signal);
        const absolute = resolved.canonical ?? resolved.absolute;
        const reasons: string[] = [];
        let diagnostic: ImoSkillValidationDiagnostic | undefined;
        const addPathReason = (code: string): void => {
          reasons.push(code);
          diagnostic = { code };
        };
        if (resolved.reason === "outside-allowed-root") {
          // The resolver rejects lexically before any candidate stat/access/read.
          addPathReason("outside-allowed-root");
        } else if (resolved.reason === "missing") {
          addPathReason("missing-directory");
        } else if (resolved.reason === "unreadable") {
          addPathReason("path-unreadable");
        } else if (resolved.canonical === undefined) {
          addPathReason("missing-directory");
        } else {
          try {
            throwIfSkillAborted(signal);
            if (!(await stat(resolved.canonical)).isDirectory()) {
              addPathReason("not-directory");
            } else {
              throwIfSkillAborted(signal);
              const manifest = await resolveSkillPath(
                join(resolved.canonical, "SKILL.md"),
                this.skillsAllowedRoot,
                allowedRoot,
              );
              throwIfSkillAborted(signal);
              if (manifest.reason === "outside-allowed-root") {
                addPathReason("outside-allowed-root");
              } else if (manifest.reason === "unreadable") {
                addPathReason("skill-md-unreadable");
              } else if (manifest.canonical === undefined) {
                addPathReason("missing-skill-md");
              } else {
                try {
                  throwIfSkillAborted(signal);
                  if (!(await stat(manifest.canonical)).isFile()) {
                    addPathReason("missing-skill-md");
                  } else {
                    const inspection = await inspectSkillDocument(manifest.canonical, signal);
                    throwIfSkillAborted(signal);
                    if (inspection.invalid) {
                      const issue: SkillDocumentIssue = inspection.issue ?? {
                        code: "skill-file-unreadable",
                        canonicalInvalid: false,
                      };
                      const issueCode = issue.code === "skill-file-unreadable" ? "skill-md-unreadable" : issue.code;
                      reasons.push(issueCode);
                      diagnostic = {
                        code: issueCode,
                        canonicalInvalid: issue.canonicalInvalid,
                        ...(issue.line === undefined ? {} : { line: issue.line }),
                      };
                    }
                  }
                  throwIfSkillAborted(signal);
                } catch (error) {
                  if (isSkillAbortError(error)) throw error;
                  addPathReason("skill-md-unreadable");
                }
              }
            }
          } catch (error) {
            if (isSkillAbortError(error)) throw error;
            addPathReason("path-unreadable");
          }
        }
        items.push({
          name: skill.name,
          description: skill.description,
          path: absolute,
          valid: reasons.length === 0,
          reasons,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        });
      }
      throwIfSkillAborted(signal);
      return {
        ok: true,
        value: { scope, inventoryComplete: items.every((item) => item.valid), items, checkedAt: new Date().toISOString() },
      };
    } catch (error) {
      if (isSkillAbortError(error)) return cancelledSkillsResult(this.config.command, args);
      throw error;
    }
  }
}

function cancelledSkillsResult<T>(command: string, args: readonly string[]): ImoResult<T> {
  return {
    ok: false,
    error: { code: "cancelled", message: "IMO Skills operation was cancelled", command, args },
  };
}

function parseSkillsError(
  run: { value: { stdoutDigest: string; stderrDigest: string } },
  command: string,
  args: readonly string[],
  message: string,
): ImoResult<never> {
  return {
    ok: false,
    error: {
      code: "parse-error",
      message,
      command,
      args,
      stdoutDigest: run.value.stdoutDigest,
      stderrDigest: run.value.stderrDigest,
    },
  };
}

