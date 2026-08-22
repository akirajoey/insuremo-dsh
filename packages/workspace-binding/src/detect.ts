import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Strong-signature subdirectories of `.metadata` that identify a project. */
const METADATA_KINDS = ["api", "function", "batch", "model"] as const;

async function hasMetadataJson(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some(entry => entry.isFile() && entry.name.endsWith(".metadata.json"));
  } catch {
    return false;
  }
}

async function hasGroovy(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some(entry => entry.isFile() && entry.name.endsWith(".groovy"));
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * Read-only iComposer project detection (strong signatures only, so plain
 * directories are never disturbed):
 *   - `.metadata/` exists and any of {api,function,batch,model}/ contains
 *     `*.metadata.json`; or
 *   - `src/dev/` exists and contains `.groovy` sources.
 */
export async function detectIcomposerProject(canonicalPath: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const metadataDir = join(canonicalPath, ".metadata");
  if (await dirExists(metadataDir)) {
    for (const kind of METADATA_KINDS) {
      if (signal?.aborted) return false;
      if (await hasMetadataJson(join(metadataDir, kind))) return true;
    }
  }
  if (signal?.aborted) return false;
  const srcDev = join(canonicalPath, "src", "dev");
  if (await dirExists(srcDev)) {
    // bounded tenant → group → {api,function} → asset traversal; a groovy
    // anywhere on these canonical iComposer levels is a strong signature
    try {
      const tenants = await readdir(srcDev, { withFileTypes: true });
      for (const tenant of tenants.slice(0, 64)) {
        if (!tenant.isDirectory()) continue;
        if (signal?.aborted) return false;
        const tenantDir = join(srcDev, tenant.name);
        if (await hasGroovy(tenantDir)) return true;
        let groups: Array<{ name: string; isDirectory(): boolean }> = [];
        try { groups = (await readdir(tenantDir, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { continue; }
        for (const group of groups.slice(0, 64)) {
          if (!group.isDirectory()) continue;
          if (signal?.aborted) return false;
          const groupDir = join(tenantDir, group.name);
          if (await hasGroovy(groupDir)) return true;
          for (const kind of ["api", "function"]) {
            const kindDir = join(groupDir, kind);
            if (!(await dirExists(kindDir))) continue;
            let assets: Array<{ name: string; isDirectory(): boolean }> = [];
            try { assets = (await readdir(kindDir, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean }>; } catch { continue; }
            for (const asset of assets.slice(0, 64)) {
              if (!asset.isDirectory()) continue;
              if (await hasGroovy(join(kindDir, asset.name))) return true;
              // nested method subdirs also count (src/dev/**/api/<Name>/<method>.groovy)
              try {
                const nested = (await readdir(join(kindDir, asset.name), { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean }>;
                for (const sub of nested.slice(0, 16)) {
                  if (sub.isDirectory() && await hasGroovy(join(kindDir, asset.name, sub.name))) return true;
                }
              } catch { /* unreadable */ }
            }
          }
        }
      }
    } catch { /* unreadable */ }
  }
  return false;
}

/** Derive the bind triple from an auth profile view; null when incomplete. */
export function deriveBindIdentity(profile: { profileName: string; envId?: string; tenantCode?: string } | null | undefined): { environmentId: string; tenantCode: string; authProfile: string } | null {
  if (profile === null || profile === undefined) return null;
  const environmentId = typeof profile.envId === "string" && profile.envId.length > 0 ? profile.envId : undefined;
  const tenantCode = typeof profile.tenantCode === "string" && profile.tenantCode.length > 0 ? profile.tenantCode : undefined;
  const authProfile = typeof profile.profileName === "string" && profile.profileName.length > 0 ? profile.profileName : undefined;
  if (environmentId === undefined || tenantCode === undefined || authProfile === undefined) return null;
  return { environmentId, tenantCode, authProfile };
}
