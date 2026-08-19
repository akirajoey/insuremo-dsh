import { access, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "./config.ts";
import { mapRunFailure, runCapture, type ImoResult } from "./run.ts";

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

export interface ImoSkillValidationItem {
  readonly name: string;
  readonly description: string;
  /** Absolute path used for validation. */
  readonly path: string;
  readonly valid: boolean;
  readonly reasons: readonly string[];
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
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return parseSkillsError(run, this.config.command, args, "skills list output was not valid JSON");
    }
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
    this.ctx.emit(SKILLS_INVENTORY_UPDATED_EVENT, { scope, skills: [...skills], stdoutDigest });
    return { ok: true, value: { scope, skills, stdoutDigest } };
  }

  async configPath(signal?: AbortSignal): Promise<ImoResult<ImoSkillConfigPath>> {
    const args = ["skills", "config", "path"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    const path = run.value.stdout.text.split(/\r?\n/)[0]?.trim() ?? "";
    let exists = false;
    try {
      exists = (await stat(path)).isFile();
    } catch {
      exists = false; // an absent config file must not crash the read
    }
    return { ok: true, value: { path, exists } };
  }

  async validate(scope: ImoSkillScope = "project", signal?: AbortSignal): Promise<ImoResult<ImoSkillValidation>> {
    const listResult = await this.list(scope, signal);
    if (!listResult.ok) return listResult;
    const allowedRoot = await resolveAllowedSkillRoot(this.skillsAllowedRoot);
    const items: ImoSkillValidationItem[] = [];
    for (const skill of listResult.value.skills) {
      const resolved = await resolveSkillPath(skill.path, this.skillsAllowedRoot, allowedRoot);
      const absolute = resolved.canonical ?? resolved.absolute;
      const reasons: string[] = [];
      if (resolved.reason === "outside-allowed-root") {
        // The resolver rejects lexically before any candidate stat/access/read.
        reasons.push("outside-allowed-root");
      } else if (resolved.reason === "missing") {
        reasons.push("missing-directory");
      } else if (resolved.canonical === undefined) {
        reasons.push("missing-directory");
      } else {
        try {
          if (!(await stat(resolved.canonical)).isDirectory()) {
            reasons.push("not-directory");
          } else {
            const manifest = await resolveSkillPath(
              join(resolved.canonical, "SKILL.md"),
              this.skillsAllowedRoot,
              allowedRoot,
            );
            if (manifest.reason === "outside-allowed-root") {
              reasons.push("outside-allowed-root");
            } else if (manifest.canonical === undefined) {
              reasons.push("missing-skill-md");
            } else {
              try {
                if (!(await stat(manifest.canonical)).isFile()) reasons.push("missing-skill-md");
              } catch {
                reasons.push("missing-skill-md");
              }
            }
          }
        } catch {
          reasons.push("missing-directory");
        }
      }
      items.push({ name: skill.name, description: skill.description, path: absolute, valid: reasons.length === 0, reasons });
    }
    return {
      ok: true,
      value: { scope, inventoryComplete: items.every((item) => item.valid), items, checkedAt: new Date().toISOString() },
    };
  }
}

type SkillPathReason = "outside-allowed-root" | "missing";

interface AllowedSkillRoot {
  readonly lexical: string;
  readonly canonical: string;
}

interface ResolvedSkillPath {
  readonly absolute: string;
  readonly canonical?: string;
  readonly reason?: SkillPathReason;
}

/** A non-empty relative path is contained; the root itself is not a skill dir. */
function isContainedSkillPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function resolveAllowedSkillRoot(rootPath: string): Promise<AllowedSkillRoot | null> {
  const lexical = resolve(rootPath);
  try {
    const canonical = await realpath(lexical);
    if (!(await stat(canonical)).isDirectory()) return null;
    return { lexical, canonical };
  } catch {
    return null;
  }
}

/**
 * The sole inventory/provider path resolver. It first rejects lexical escapes,
 * then realpaths an existing candidate and rejects symlink escapes before the
 * caller is allowed to stat, access, or read the candidate.
 */
async function resolveSkillPath(
  skillPath: string,
  allowedRootPath: string,
  allowedRoot: AllowedSkillRoot | null,
): Promise<ResolvedSkillPath> {
  const lexicalRoot = resolve(allowedRootPath);
  const absolute = resolve(lexicalRoot, skillPath);
  if (
    allowedRoot === null
    || (absolute !== allowedRoot.lexical && absolute !== allowedRoot.canonical
      && !isContainedSkillPath(allowedRoot.lexical, absolute)
      && !isContainedSkillPath(allowedRoot.canonical, absolute))
  ) {
    return { absolute, reason: "outside-allowed-root" };
  }
  try {
    const canonical = await realpath(absolute);
    if (canonical === allowedRoot.canonical || !isContainedSkillPath(allowedRoot.canonical, canonical)) {
      return { absolute, reason: "outside-allowed-root" };
    }
    return { absolute: canonical, canonical };
  } catch {
    return { absolute, reason: "missing" };
  }
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

// ---- InsureMO skill provider skeleton (harness catalog wiring deferred) ----

/** One skill destined for a future Harness skill catalog, digests/frontmatter only. */
export interface ImoSkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the skill directory. */
  readonly path: string;
  readonly valid: boolean;
  readonly reasons: readonly string[];
  /** Parsed SKILL.md frontmatter (title/description etc.), when present. */
  readonly frontmatter?: Readonly<Record<string, string>>;
}

export interface InsuremoSkillSnapshot {
  readonly source: "imo";
  readonly scope: ImoSkillScope;
  readonly generatedAt: string;
  readonly inventoryComplete: boolean;
  readonly skills: readonly ImoSkillCatalogEntry[];
}

/** The provider contract the future `dsh-skill` catalog card will satisfy. */
export interface InsuremoSkillProvider {
  readonly id: "insuremo";
  snapshot(scope: ImoSkillScope, signal?: AbortSignal): Promise<InsuremoSkillSnapshot>;
}

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_FRONTMATTER_LINES = 128;

/**
 * Read only a bounded, contained SKILL.md prefix. This helper is deliberately
 * private: callers can only reach it through a validated provider snapshot.
 */
async function readSkillFrontmatter(
  skillMdPath: string,
  allowedRootPath: string,
): Promise<Record<string, string> | null> {
  const allowedRoot = await resolveAllowedSkillRoot(allowedRootPath);
  const resolved = await resolveSkillPath(skillMdPath, allowedRootPath, allowedRoot);
  if (resolved.canonical === undefined) return null;
  try {
    if (!(await stat(resolved.canonical)).isFile()) return null;
  } catch {
    return null;
  }

  let file: FileHandle | undefined;
  try {
    file = await open(resolved.canonical, "r");
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    // Exact opening and closing delimiter lines are required. In particular,
    // never interpret body lines as frontmatter when the close is absent.
    if (lines[0] !== "---") return null;
    const closing = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closing < 0 || closing > MAX_FRONTMATTER_LINES) return null;
    const frontmatter: Record<string, string> = {};
    let fields = 0;
    for (const line of lines.slice(1, closing)) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (match) {
        if (++fields > MAX_FRONTMATTER_LINES) return null;
        frontmatter[match[1]] = match[2]?.trim() ?? "";
      }
    }
    return frontmatter;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/**
 * Skeleton provider factory: binds the read-only inventory service into the
 * future `@deepseek-ai/dsh-skill` catalog provider shape. Registering into the
 * Harness skill registry is deliberately deferred to a dedicated card.
 */
export function createInsuremoSkillProvider(skills: ImoSkills): InsuremoSkillProvider {
  const allowedRoot = (skills as ImoSkills & { readonly skillsAllowedRoot?: string }).skillsAllowedRoot ?? homedir();
  return {
    id: "insuremo",
    async snapshot(scope, signal) {
      const resolved = await skills.validate(scope, signal);
      const entries: ImoSkillCatalogEntry[] = resolved.ok
        ? await Promise.all(resolved.value.items
            .filter((item) => item.valid)
            .map(async (item) => {
              const frontmatter = await readSkillFrontmatter(join(item.path, "SKILL.md"), allowedRoot);
              return {
                name: item.name,
                description: item.description,
                path: item.path,
                valid: true,
                reasons: [],
                ...(frontmatter === null ? {} : { frontmatter }),
              };
            }))
        : [];
      return {
        source: "imo",
        scope,
        generatedAt: new Date().toISOString(),
        inventoryComplete: resolved.ok ? resolved.value.inventoryComplete : false,
        skills: entries,
      };
    },
  };
}

/**
 * Registration placeholder for the future Harness skill catalog card. It is
 * intentionally a no-op in TASK-010: no `dsh-skill` registry is mutated yet.
 */
export function registerInsuremoSkillProvider(_provider: InsuremoSkillProvider): () => void {
  return () => {};
}

