import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IciManifest } from "./types.ts";

export function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function workspaceHash(canonicalPathInput: string, workspaceId: string): string {
  let canonicalPath = canonicalPathInput;
  try { canonicalPath = realpathSync(canonicalPathInput); } catch {}
  return createHash("sha256").update(`${canonicalPath}:${workspaceId}`).digest("hex").slice(0, 16);
}

export function graphBaseDir(canonicalPath: string, workspaceId: string): string {
  return join(getDshHome(), "ici", workspaceHash(canonicalPath, workspaceId), "graph");
}

export function currentDir(base: string): string {
  return join(base, "current");
}

export function stagingDir(base: string): string {
  return join(base, `staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

export async function readManifest(base: string): Promise<IciManifest | null> {
  try {
    const text = await readFile(join(currentDir(base), "manifest.json"), "utf8");
    return JSON.parse(text) as IciManifest;
  } catch {
    return null;
  }
}

export interface WriteAtomicOptions {
  readonly signal?: AbortSignal;
  /** Test seam: override rename to inject promote failures. */
  readonly renameFn?: typeof rename;
  /** Test seam: override rm to inject cleanup failures. */
  readonly rmFn?: typeof rm;
  /** Test seam / diagnostics sink for non-fatal cleanup warnings. */
  readonly warn?: (message: string) => void;
}

/**
 * Atomic snapshot write with a three-phase promote (Rust current/ semantics):
 *
 *   1. `rename(current → stale-<ts>)` — skipped when no previous version
 *      exists; failure leaves the previous `current` fully intact.
 *   2. `rename(staging → current)` — on failure the stale directory is rolled
 *      back so `current` is never half-deleted.
 *   3. `rm(stale)` — best-effort cleanup; failure only warns and does not
 *      affect the result.
 */
export async function writeAtomic(
  base: string,
  manifest: IciManifest,
  nodes: unknown[],
  edges: unknown[],
  options: WriteAtomicOptions = {},
): Promise<void> {
  const signal = options.signal;
  const renameFn = options.renameFn ?? rename;
  const rmFn = options.rmFn ?? rm;
  const warn = options.warn ?? ((message: string) => console.warn(`[ici] ${message}`));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const staging = stagingDir(base);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, "nodes.json"), JSON.stringify(nodes, null, 2), "utf8");
    await writeFile(join(staging, "edges.json"), JSON.stringify(edges, null, 2), "utf8");
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await mkdir(base, { recursive: true });
    const current = currentDir(base);

    // Phase 1: move any previous version aside. Failure here leaves `current`
    // untouched (e.g. immutable-flag scenarios) and propagates.
    const stale = join(base, `stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let movedStale = false;
    let hasCurrent = false;
    try {
      await stat(current);
      hasCurrent = true;
    } catch {
      hasCurrent = false;
    }
    if (hasCurrent) {
      try {
        await renameFn(current, stale);
        movedStale = true;
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        warn(`promote: could not move previous current aside (${String(error)}); previous version kept`);
        throw error;
      }
    }

    // Phase 2: promote staging → current; roll the stale copy back on failure
    // so `current` is never left missing.
    try {
      await renameFn(staging, current);
    } catch (error) {
      if (movedStale) {
        try {
          await renameFn(stale, current);
          movedStale = false;
        } catch (rollbackError) {
          warn(`promote rollback failed: ${String(rollbackError)}`);
        }
      }
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    // Phase 3: best-effort stale cleanup; failure only warns.
    if (movedStale) {
      try {
        await rmFn(stale, { recursive: true, force: true });
      } catch (error) {
        warn(`cleanup of stale snapshot failed: ${String(error)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException)) {
      await rmFn(staging, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
