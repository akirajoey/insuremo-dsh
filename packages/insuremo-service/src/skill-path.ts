import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Shared skill-path containment + canonicalization used by both the read-only
 * inventory validation and the catalog provider. Every candidate path
 * (directory or SKILL.md) is verified against the exact same allowed root
 * before any stat, access, or read is permitted, so the provider never
 * re-implements a looser check.
 */

/** Why a skill path could not be used. */
export type SkillPathReason = "outside-allowed-root" | "missing";

export interface AllowedSkillRoot {
  readonly lexical: string;
  readonly canonical: string;
}

export interface ResolvedSkillPath {
  /** Resolved path (canonical when a candidate existed). */
  readonly absolute: string;
  /** Present only when the path exists and its realpath stays within the root. */
  readonly canonical?: string;
  readonly reason?: SkillPathReason;
}

/** A non-empty relative path is contained; the root itself is not a skill dir. */
export function isContainedSkillPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Resolve the allowed root's canonical directory (null when absent). */
export async function resolveAllowedSkillRoot(rootPath: string): Promise<AllowedSkillRoot | null> {
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
export async function resolveSkillPath(
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
