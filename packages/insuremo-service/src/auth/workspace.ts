import type { Context } from "@deepseek-ai/cordis";
import { isAbsolute } from "node:path";

/**
 * A workspace id is an opaque registry key.  Keep the transport grammar
 * narrow even though the registry remains the authority for existence and
 * path resolution.
 */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface AuthWorkspaceEntry {
  readonly id?: unknown;
  readonly path?: unknown;
}

export interface AuthWorkspaceRegistry {
  get(id: string): AuthWorkspaceEntry | undefined;
}

export type WorkspaceResolution =
  | { readonly ok: true; readonly workspaceId: string; readonly cwd: string }
  | { readonly ok: false; readonly code: "invalid-workspace-id" | "workspace-not-found" | "workspace-unavailable"; readonly message: string };

/** Validate an id without consulting the registry. */
export function parseWorkspaceId(value: unknown): string | undefined {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Resolve a caller-provided workspace id through the Host registry.  The
 * caller never supplies a cwd: `path` comes only from the trusted registry,
 * which already canonicalizes paths on registration.
 */
export function resolveWorkspace(ctx: Context, value: unknown): WorkspaceResolution {
  if (value === undefined || value === null) {
    return { ok: false, code: "invalid-workspace-id", message: "workspace id is required" };
  }
  const workspaceId = parseWorkspaceId(value);
  if (workspaceId === undefined) {
    return { ok: false, code: "invalid-workspace-id", message: "workspace id is invalid" };
  }
  const registry = ctx.get("workspaceRegistry" as never) as unknown as AuthWorkspaceRegistry | undefined;
  if (registry === undefined || typeof registry.get !== "function") {
    return { ok: false, code: "workspace-unavailable", message: "workspace registry is unavailable" };
  }
  let entry: AuthWorkspaceEntry | undefined;
  try {
    entry = registry.get(workspaceId);
  } catch {
    return { ok: false, code: "workspace-unavailable", message: "workspace registry is unavailable" };
  }
  if (entry === undefined) {
    return { ok: false, code: "workspace-not-found", message: "workspace does not exist" };
  }
  // The registry implementation returns the requested id, but retain this
  // check for defensive test doubles and future adapters.
  if (entry.id !== undefined && String(entry.id) !== workspaceId) {
    return { ok: false, code: "workspace-unavailable", message: "workspace identity could not be verified" };
  }
  if (typeof entry.path !== "string" || entry.path.length === 0 || !isAbsolute(entry.path)) {
    return { ok: false, code: "workspace-unavailable", message: "workspace path could not be verified" };
  }
  return { ok: true, workspaceId, cwd: entry.path };
}

/** Stable cache namespace for a resolved workspace identity and path. */
export function workspaceScopeKey(workspaceId: string, cwd: string): string {
  return JSON.stringify([workspaceId, cwd]);
}
