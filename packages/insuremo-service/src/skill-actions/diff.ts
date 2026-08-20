import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { ImoSkills } from "../skills.ts";
import { digest } from "../run.ts";
import { resolveAllowedSkillRoot, resolveSkillPath } from "../skill-path.ts";
import type {
  SkillActionError,
  SkillActionResult,
  SkillInventorySnapshot,
} from "./types.ts";

const MAX_SKILLS = 512;
const MAX_MANIFEST_BYTES = 512 * 1024;

export interface SkillInventoryDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
}

export async function snapshotInventory(
  skills: ImoSkills,
  signal?: AbortSignal,
): Promise<SkillActionResult<SkillInventorySnapshot>> {
  if (signal?.aborted) return failure("cancelled", "skill inventory operation was cancelled");
  try {
    const listed = await skills.list("global", signal);
    if (!listed.ok) return mapReadError(listed.error.code, listed.error.message, listed.error.stdoutDigest, listed.error.stderrDigest);
    const names = listed.value.skills
      .map(skill => skill.name)
      .filter((name): name is string => isSkillName(name))
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort((left, right) => left.localeCompare(right));
    if (names.length > MAX_SKILLS) return failure("pre-check-failed", "global skill inventory exceeds the bounded action limit");
    const digests: Record<string, string> = {};
    const validation = await skills.validate("global", signal);
    if (!validation.ok) return mapReadError(validation.error.code, validation.error.message, validation.error.stdoutDigest, validation.error.stderrDigest);
    const root = allowedRootOf(skills);
    const allowedRoot = await resolveAllowedSkillRoot(root);
    for (const item of validation.value.items) {
      if (signal?.aborted) return failure("cancelled", "skill inventory operation was cancelled");
      if (!item.valid || !names.includes(item.name)) continue;
      const manifest = await resolveSkillPath(join(item.path, "SKILL.md"), root, allowedRoot);
      if (manifest.canonical === undefined) continue;
      try {
        const info = await stat(manifest.canonical);
        if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) continue;
        const content = await readFile(manifest.canonical, "utf8");
        digests[item.name] = digest(content);
      } catch {
        // A damaged row remains an inventory name but contributes no content digest.
      }
    }
    return {
      ok: true,
      value: {
        names,
        digests: Object.freeze({ ...digests }),
        inventoryDigest: digest(JSON.stringify({ names, digests })),
      },
    };
  } catch (error) {
    if (signal?.aborted) return failure("cancelled", "skill inventory operation was cancelled");
    return failure("pre-check-failed", "could not read the global skill inventory");
  }
}

export function diffInventory(before: SkillInventorySnapshot, after: SkillInventorySnapshot): SkillInventoryDiff {
  const beforeSet = new Set(before.names);
  const afterSet = new Set(after.names);
  const added = after.names.filter(name => !beforeSet.has(name));
  const removed = before.names.filter(name => !afterSet.has(name));
  const updated = after.names.filter(name => beforeSet.has(name) && before.digests[name] !== after.digests[name]);
  return {
    added: [...added].sort((left, right) => left.localeCompare(right)),
    removed: [...removed].sort((left, right) => left.localeCompare(right)),
    updated: [...updated].sort((left, right) => left.localeCompare(right)),
  };
}

function allowedRootOf(skills: ImoSkills): string {
  const value = (skills as unknown as { skillsAllowedRoot?: unknown }).skillsAllowedRoot;
  return typeof value === "string" && value.length > 0 ? value : homedir();
}

function mapReadError(
  code: string,
  message: string,
  stdoutDigest?: string,
  stderrDigest?: string,
): SkillActionResult<never> {
  const allowed = new Set(["cancelled", "not-found", "spawn-failed", "non-zero-exit", "timeout", "parse-error"]);
  return {
    ok: false,
    error: {
      code: allowed.has(code) ? code as SkillActionError["code"] : "pre-check-failed",
      message: allowed.has(code) ? message : "could not read the global skill inventory",
      ...(stdoutDigest === undefined ? {} : { stdoutDigest }),
      ...(stderrDigest === undefined ? {} : { stderrDigest }),
    },
  };
}

function failure<T = never>(code: SkillActionError["code"], message: string): SkillActionResult<T> {
  return { ok: false, error: { code, message } };
}
