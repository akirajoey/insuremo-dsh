/**
 * imo CLI profile-store reader (TASK-041): millisecond direct read of the
 * CLI's plaintext `auth-profiles.json` — no subprocess, no token material.
 */
import type { ImoAuthProfileView, ImoAuthResult } from "./types.ts";

export const LIST_CACHE_TTL_MS = 60_000;

/**
 * Candidate imo CLI profile-store locations (TASK-041): the CLI is a Node
 * app using platform config dirs — macOS Application Support first, then the
 * XDG/Linux and ~/.insuremo spellings. Only descriptive fields are mapped;
 * token material in the file is never read into memory.
 */
export async function readProfileStore(): Promise<{ profiles: readonly ImoAuthProfileView[]; defaultProfile: string | null } | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const home = homedir();
    const candidates = [
      join(home, "Library", "Application Support", "insuremo", "auth-profiles.json"),
      join(home, ".config", "insuremo", "auth-profiles.json"),
      join(home, ".insuremo", "auth-profiles.json"),
    ];
    for (const candidate of candidates) {
      let text: string;
      try {
        text = await readFile(candidate, "utf8");
      } catch {
        continue;
      }
      const parsed = JSON.parse(text) as {
        profiles?: Record<string, Record<string, unknown>>;
        default_profile?: unknown;
      };
      if (parsed.profiles === undefined || typeof parsed.profiles !== "object") continue;
      const defaultProfile = typeof parsed.default_profile === "string" ? parsed.default_profile : null;
      const str = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
      const profiles = Object.entries(parsed.profiles)
        .filter(([name]) => typeof name === "string" && name.length > 0)
        .slice(0, 100)
        .map(([name, raw]) => Object.freeze({
          profileName: name,
          env: str(raw.env),
          tenantCode: str(raw.tenant_code),
          accountName: str(raw.account_name),
          domain: str(raw.domain),
          gateway: str(raw.gateway),
          tenantDomain: str(raw.tenant_domain),
          source: str(raw.source),
          userSourceId: str(raw.user_source_id),
          isDefault: defaultProfile === name,
        }))
        .sort((left, right) => left.profileName.localeCompare(right.profileName));
      return { profiles: Object.freeze(profiles), defaultProfile };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function authCancelled(command: string): ImoAuthResult<never> {
  return { ok: false, error: { code: "cancelled", message: `imo command cancelled: ${command}`, command } };
}
