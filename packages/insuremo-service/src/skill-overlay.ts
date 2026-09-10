import { isSkillName } from "@deepseek-ai/dsh-skill";

/**
 * TASK-100 skill context overlay: append a FIXED, code-owned Workbench policy
 * note to the body a skill provider returns for allowlisted skill names.
 *
 * The overlay is applied only at the final provider `get()` return, AFTER the
 * canonical frontmatter has been parsed and sliced away, so installed skill
 * files, catalog rows, summaries, TASK-092 diagnostics, and frontmatter
 * semantics are untouched. Configuration decides ONLY the exact-name
 * allowlist and the on/off switch; the text below is a code constant — no
 * caller- or config-supplied text is ever interpolated.
 */
export const SKILL_OVERLAY_TEXT = [
  "",
  "---",
  "",
  "## Workbench policy overlay",
  "",
  "> This section is appended by the InsureMO Workbench plugin.",
  "> It is NOT part of the upstream skill document.",
  "",
  "- Auth commands that persist credentials — `imo auth login`, `imo auth token set`,",
  "  `imo auth remote-profile create`, `imo auth default-profile set` — run with",
  "  `--scope workspace` by default in this Workbench.",
  "- Workspace-scope credentials are written under `<workspace>/.insuremo/`, inside",
  "  the sandbox's writable roots.",
  "- Use `--scope global` only when the user explicitly asks for machine-global",
  "  persistence; global writes land outside the sandbox and may need user approval.",
  "",
].join("\n");

/**
 * Hard byte bound for the fixed template. The text is code-owned so the bound
 * holds by construction; the resolver re-checks it as a pinned invariant.
 */
export const SKILL_OVERLAY_MAX_BYTES = 8 * 1024;

/** Upper bound on allowlisted names; a longer list is a configuration error. */
export const SKILL_OVERLAY_MAX_NAMES = 16;

/** Default allowlist: the one skill whose auth guidance benefits from the overlay. */
export const DEFAULT_SKILL_OVERLAY_NAMES: readonly string[] = ["insuremo-auth-cli"];

/** Raw overlay settings as supplied by configuration (all fields optional). */
export interface SkillOverlaySettings {
  /** Whether the overlay is applied at all (default true). */
  readonly enabled?: boolean;
  /** Exact skill names receiving the overlay (default: DEFAULT_SKILL_OVERLAY_NAMES). */
  readonly names?: readonly string[];
}

/** Resolved, frozen overlay configuration consumed by the provider. */
export interface SkillOverlayConfig {
  readonly enabled: boolean;
  readonly names: readonly string[];
}

/**
 * Resolve and validate overlay configuration. Invalid names, duplicates, and
 * over-long lists fail loud here (service construction) instead of silently
 * degrading — the same fail-loud pattern as the package's other config knobs.
 */
export function resolveSkillOverlayConfig(settings: SkillOverlaySettings = {}): SkillOverlayConfig {
  const enabled = settings.enabled ?? true;
  const rawNames = settings.names ?? DEFAULT_SKILL_OVERLAY_NAMES;
  if (!Array.isArray(rawNames)) throw new Error("skill-overlay: overlay names must be an array of skill names");
  if (rawNames.length > SKILL_OVERLAY_MAX_NAMES) {
    throw new Error(`skill-overlay: overlay allowlist exceeds ${SKILL_OVERLAY_MAX_NAMES} names`);
  }
  const seen = new Set<string>();
  for (const name of rawNames) {
    if (typeof name !== "string" || name.length === 0 || !isSkillName(name)) {
      throw new Error(`skill-overlay: invalid overlay skill name ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`skill-overlay: duplicate overlay skill name "${name}"`);
    seen.add(name);
  }
  if (Buffer.byteLength(SKILL_OVERLAY_TEXT, "utf8") > SKILL_OVERLAY_MAX_BYTES) {
    throw new Error("skill-overlay: fixed overlay template exceeds its byte bound");
  }
  return Object.freeze({ enabled, names: Object.freeze([...rawNames]) });
}

/**
 * Append the fixed overlay to `content` when `skillName` is allowlisted and
 * the overlay is enabled; otherwise return `content` unchanged. Exact-name
 * matching only — no content sniffing, no partial matches.
 */
export function applySkillOverlay(skillName: string, content: string, overlay: SkillOverlayConfig): string {
  if (!overlay.enabled || !overlay.names.includes(skillName)) return content;
  return `${content}${SKILL_OVERLAY_TEXT}`;
}
