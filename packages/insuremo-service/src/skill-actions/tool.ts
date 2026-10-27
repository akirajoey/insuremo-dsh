import { IMO_REGISTRY } from "../imo-install.ts";

/**
 * The independent InsureMO Skills CLI. Inventory, config path, install, update
 * and remove all go through this package via `npx`; the `imo` binary no longer
 * exposes `skills` in the observed 0.2.37, so nothing here may depend on it.
 *
 * This module is a leaf: `skills.ts` and `skill-actions/preview.ts` both need
 * these values, and `preview.ts` imports `skills.ts` — keeping the constants
 * here avoids that cycle.
 */
export const SKILLS_TOOL_COMMAND = "npx" as const;
export const SKILLS_TOOL_PACKAGE = "@insuremo/skills-tool" as const;
export const SKILLS_TOOL_REGISTRY: string = IMO_REGISTRY;

/** The shared deterministic output overlay for catalog reads and install dry-runs. */
export const SKILLS_TOOL_DISCOVERY_ENV = Object.freeze({ CI: "true", FORCE_COLOR: "0", TERM: "dumb" });

/**
 * argv for one skills-tool run: `npx -y --registry=… @insuremo/skills-tool <args> --skip-update-check`.
 * `--skip-update-check` is always last so every invocation stays read-only with
 * respect to the tool's own self-update.
 * @param args - the tool subcommand and its arguments.
 * @returns the complete argv handed to the subprocess seam.
 */
export function skillsToolArgs(...args: readonly string[]): readonly string[] {
  return ["-y", `--registry=${SKILLS_TOOL_REGISTRY}`, SKILLS_TOOL_PACKAGE, ...args, "--skip-update-check"];
}
