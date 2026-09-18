import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * TASK-111: the single path-aware source enumerator of the workspace.
 *
 * The catalog's *summary* (`listAssets`) is keyed by asset name and bounded by
 * `MAX_ASSETS` for display. Tasks must not inherit either property: one task may
 * target every API of a workspace, and two same-named APIs in different code
 * groups are two different assets. This walk therefore yields one item per
 * **source file path**, without any count cap, so callers can (a) build the
 * complete graph and (b) detect same-name collisions instead of merging them.
 *
 * Safety rules kept from the summary scan: only regular, non-symlink files under
 * `src/dev/<tenant>/<group>/<type>/<name>/` are produced, and an unreadable entry
 * is skipped rather than inventing an asset.
 */

/** One directory-entry name bound (mirrors the summary scan's name handling). */
const MAX_NAME = 512;

export interface SourceDiscovery {
  readonly name: string;
  readonly type: "api" | "function";
  readonly tenant: string;
  readonly group: string;
  /** Workspace-relative POSIX path of the source file (the stable identity of a discovery). */
  readonly relativePath: string;
  /** Absolute path of the source file, for the caller's own containment checks. */
  readonly absolutePath: string;
}

function usable(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && name.length <= MAX_NAME && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function contained(target: string, root: string): boolean { return target === root || target.startsWith(`${root}/`); }

/**
 * The same containment rule the summary scan and the graph builder apply
 * (`scan.ts` `isContained` / `graph.ts` `isContained`): a directory may only be
 * followed when its *real* path stays inside the walk root, so a symlink at any
 * level of `<tenant>/<group>/<type>/<name>` can never widen the enumeration
 * beyond the workspace's own source tree.
 */
async function containedDirectory(dir: string, rootReal: string): Promise<boolean> {
  try { return contained(await realpath(dir), rootReal); } catch { return false; }
}

async function subdirectories(dir: string): Promise<string[]> {
  let names: string[];
  try { names = await import("node:fs/promises").then(fs => fs.readdir(dir)); } catch { return []; }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (!usable(name)) continue;
    try { const info = await lstat(join(dir, name)); if (info.isDirectory() && !info.isSymbolicLink()) out.push(name); } catch { /* unreadable entry */ }
  }
  return out;
}

/**
 * Every deployed api/function source of a workspace as (path, name, tenant, group),
 * in a deterministic (tenant, group, name) order. Uncapped on purpose.
 */
export async function* enumerateSources(canonicalRootInput: string, types: readonly ("api" | "function")[] = ["api", "function"]): AsyncGenerator<SourceDiscovery> {
  const workspaceReal = await realpath(canonicalRootInput).catch(() => undefined);
  if (workspaceReal === undefined) return;
  const devRoot = join(workspaceReal, "src", "dev");
  const devReal = await realpath(devRoot).catch(() => undefined);
  if (devReal === undefined) return;
  for (const tenant of await subdirectories(devRoot)) {
    if (!(await containedDirectory(join(devRoot, tenant), devReal))) continue;
    for (const group of await subdirectories(join(devRoot, tenant))) {
      const groupDir = join(devRoot, tenant, group);
      if (!(await containedDirectory(groupDir, devReal))) continue;
      for (const type of types) {
        const typeDir = join(groupDir, type);
        if (!(await containedDirectory(typeDir, devReal))) continue;
        for (const name of await subdirectories(typeDir)) {
          const absolutePath = join(typeDir, name, `${name}.groovy`);
          try {
            const info = await lstat(absolutePath);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            // Real-path containment on the leaf as well: a symlinked ancestor is
            // already rejected above, and this closes the remaining escapes.
            if (!contained(await realpath(absolutePath), devReal)) continue;
          } catch { continue; }
          yield { name, type, tenant, group, relativePath: `src/dev/${tenant}/${group}/${type}/${name}/${name}.groovy`, absolutePath };
        }
      }
    }
  }
}

/** Names discovered at more than one source path: these are two distinct assets, never one. */
export function duplicateNames(discoveries: Iterable<SourceDiscovery>): string[] {
  const pathsByName = new Map<string, Set<string>>();
  for (const item of discoveries) {
    const paths = pathsByName.get(item.name) ?? new Set<string>();
    paths.add(item.relativePath);
    pathsByName.set(item.name, paths);
  }
  return [...pathsByName.entries()].filter(([, paths]) => paths.size > 1).map(([name]) => name).sort();
}

/** Group directory names available in a workspace (for explicit selector diagnostics). */
export async function listSourceGroups(canonicalRootInput: string): Promise<Array<{ tenant: string; group: string }>> {
  const workspaceReal = await realpath(canonicalRootInput).catch(() => undefined);
  if (workspaceReal === undefined) return [];
  const devRoot = join(workspaceReal, "src", "dev");
  const devReal = await realpath(devRoot).catch(() => undefined);
  if (devReal === undefined) return [];
  const out: Array<{ tenant: string; group: string }> = [];
  for (const tenant of await subdirectories(devRoot)) {
    if (!(await containedDirectory(join(devRoot, tenant), devReal))) continue;
    for (const group of await subdirectories(join(devRoot, tenant))) {
      if (!(await containedDirectory(join(devRoot, tenant, group), devReal))) continue;
      out.push({ tenant, group });
    }
  }
  return out;
}
