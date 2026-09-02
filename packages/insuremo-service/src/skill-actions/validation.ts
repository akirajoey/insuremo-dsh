import { isSkillName } from "@deepseek-ai/dsh-skill";
import { digest } from "../run.ts";
import {
  SKILL_AGENTS,
  SKILL_SCENARIOS,
  SKILL_ACTIVATION_KIND,
  SKILL_INSTALL_KIND,
  SKILL_REMOVE_KIND,
  SKILL_UPDATE_KIND,
  type NormalizedInstallAction,
  type NormalizedSkillAction,
  type SkillActionError,
  type SkillActionInput,
  type SkillActionResult,
  type SkillAgent,
} from "./types.ts";

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NPM_UNSCOPED = /^[a-z0-9][a-z0-9._~-]{0,213}(?:@[A-Za-z0-9][A-Za-z0-9._~-]{0,127})?$/;
const NPM_SCOPED = /^@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}(?:@[A-Za-z0-9][A-Za-z0-9._~-]{0,127})?$/;
const MAX_ARG_LENGTH = 256;

export function normalizeSkillAction(input: unknown, allowedGitHosts: readonly string[]): SkillActionResult<NormalizedSkillAction> {
  if (!isRecord(input)) return failure("invalid-input", "skill action input is invalid");
  const kind = input.kind ?? input.type;
  if (typeof kind !== "string") return failure("invalid-input", "skill action kind is required");
  const scope = validateScope(input.scope);
  if (!scope.ok) return scope;
  if (kind === SKILL_INSTALL_KIND) return normalizeInstall(input, scope.value, allowedGitHosts);
  if (kind === SKILL_UPDATE_KIND) return normalizeUpdate(input, scope.value);
  if (kind === SKILL_REMOVE_KIND) return normalizeRemove(input, scope.value);
  if (kind === SKILL_ACTIVATION_KIND) return normalizeActivation(input, scope.value);
  return failure("invalid-input", "skill action kind is invalid");
}

export function skillActionParamsDigest(action: NormalizedSkillAction): string {
  return digest(JSON.stringify({ kind: action.kind, input: action }));
}

function normalizeInstall(
  input: Record<string, unknown>,
  scope: "global",
  allowedGitHosts: readonly string[],
): SkillActionResult<NormalizedSkillAction> {
  if (input.all === true) return failure("invalid-option", "install --all is not supported");
  const agent = validateAgent(input.agent);
  if (!agent.ok) return agent;
  const skills = validateNames(input.skills);
  if (!skills.ok) return skills;
  const source = normalizeSource(input.source, allowedGitHosts);
  if (!source.ok) return source;
  // Scenario sync is a fixed universal/global flow (TASK-079); any other
  // agent would diverge the executed argv from the approved parameters.
  if (source.value.type === "scenario" && agent.value !== "universal") {
    return failure("invalid-agent", "scenario install requires the universal agent");
  }
  return { ok: true, value: { kind: SKILL_INSTALL_KIND, scope, agent: agent.value, source: source.value, skills: skills.value } };
}

function normalizeUpdate(input: Record<string, unknown>, scope: "global"): SkillActionResult<NormalizedSkillAction> {
  if (input.all === false) return failure("invalid-option", "skill update requires --all");
  return { ok: true, value: { kind: SKILL_UPDATE_KIND, scope } };
}

function normalizeRemove(input: Record<string, unknown>, scope: "global"): SkillActionResult<NormalizedSkillAction> {
  if (input.all === true) return failure("invalid-option", "remove --all is not supported");
  const agent = validateAgent(input.agent);
  if (!agent.ok) return agent;
  const names = validateNames(input.names ?? input.skills);
  if (!names.ok) return names;
  if (names.value.length === 0) return failure("invalid-input", "at least one skill name is required");
  return { ok: true, value: { kind: SKILL_REMOVE_KIND, scope, agent: agent.value, names: names.value } };
}

function normalizeActivation(input: Record<string, unknown>, scope: "global"): SkillActionResult<NormalizedSkillAction> {
  if (typeof input.enabled !== "boolean") return failure("invalid-input", "activation enabled must be boolean");
  const name = validateName(input.name);
  if (!name.ok) return name;
  return { ok: true, value: { kind: SKILL_ACTIVATION_KIND, scope, name: name.value, enabled: input.enabled } };
}

function normalizeSource(value: unknown, allowedGitHosts: readonly string[]): SkillActionResult<NormalizedInstallAction["source"]> {
  if (typeof value === "string") return normalizeAlias(value);
  if (!isRecord(value) || typeof value.type !== "string") return failure("invalid-source", "skill install source is invalid");
  if (value.type === "alias") return normalizeAlias(value.value ?? value.alias);
  if (value.type === "git" || value.type === "https-git") return normalizeGit(value.url, allowedGitHosts);
  if (value.type === "npm") return normalizeNpm(value.package ?? value.packageName ?? value.value);
  if (value.type === "scenario") return normalizeScenario(value.scenario ?? value.value);
  return failure("invalid-source", "skill install source type is invalid");
}

function normalizeAlias(value: unknown): SkillActionResult<NormalizedInstallAction["source"]> {
  if (!validArg(value) || !ALIAS.test(value)) return failure("invalid-source", "skill alias is invalid");
  return { ok: true, value: { type: "alias", value } };
}

function normalizeGit(value: unknown, allowedGitHosts: readonly string[]): SkillActionResult<NormalizedInstallAction["source"]> {
  if (!validArg(value)) return failure("invalid-source", "skill git URL is invalid");
  let parsed: URL;
  try { parsed = new URL(value); } catch { return failure("invalid-source", "skill git URL is invalid"); }
  if (parsed.protocol !== "https:") return failure("invalid-source", "skill git URL must use HTTPS");
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set(allowedGitHosts.map(normalizeHost).filter((candidate): candidate is string => candidate !== undefined));
  if (!allowed.has(host)) return failure("ssrf-blocked", "skill git host is not allowed");
  if (parsed.port !== "") return failure("ssrf-blocked", "skill git ports are not allowed");
  if (parsed.pathname.length === 0 || /[\u0000-\u0020\u007f]/.test(parsed.pathname)) return failure("invalid-source", "skill git URL path is invalid");
  // A bare host without a repo path (e.g. https://github.com/) is rejected.
  const pathSegments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (pathSegments.length < 2) return failure("invalid-source", "skill git URL requires an owner/repo path");
  // URL serialization intentionally drops userinfo, query, and fragment.
  return { ok: true, value: { type: "https-git", value: `https://${host}${parsed.pathname}` } };
}

function normalizeNpm(value: unknown): SkillActionResult<NormalizedInstallAction["source"]> {
  if (!validArg(value) || (!NPM_UNSCOPED.test(value) && !NPM_SCOPED.test(value))) {
    return failure("invalid-source", "skill npm package is invalid");
  }
  return { ok: true, value: { type: "npm", value } };
}

function normalizeScenario(value: unknown): SkillActionResult<NormalizedInstallAction["source"]> {
  if (typeof value !== "string" || !SKILL_SCENARIOS.includes(value as never)) return failure("invalid-source", "skill scenario is invalid");
  return { ok: true, value: { type: "scenario", value } };
}

function validateScope(value: unknown): SkillActionResult<"global"> {
  if (value === undefined || value === "global") return { ok: true, value: "global" };
  if (value === "project" || value === "workspace") return failure("workspace-not-bound", "project skill actions require a bound workspace");
  return failure("invalid-input", "skill action scope is invalid");
}

function validateAgent(value: unknown): SkillActionResult<SkillAgent> {
  return typeof value === "string" && SKILL_AGENTS.includes(value as SkillAgent)
    ? { ok: true, value: value as SkillAgent }
    : failure("invalid-agent", "skill action agent is not in the CLI allowlist");
}

function validateNames(value: unknown): SkillActionResult<readonly string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return failure("invalid-input", "skill names must be an array");
  const names: string[] = [];
  for (const item of value) {
    const result = validateName(item);
    if (!result.ok) return result;
    if (names.includes(result.value)) return failure("invalid-input", "skill names must be unique");
    names.push(result.value);
  }
  return { ok: true, value: names.sort((left, right) => left.localeCompare(right)) };
}

function validateName(value: unknown): SkillActionResult<string> {
  return typeof value === "string" && validArg(value) && isSkillName(value)
    ? { ok: true, value }
    : failure("invalid-skill-name", "skill name is invalid");
}

function validArg(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ARG_LENGTH
    && !value.startsWith("-")
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function normalizeHost(value: string): string | undefined {
  const host = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : undefined;
}

/** Provenance allowlist for install receipts/events (never the full URL). */
export function installSourceProvenance(source: { readonly type: "alias" | "https-git" | "npm" | "scenario"; readonly value: string }): {
  readonly sourceKind: "alias" | "https-git" | "npm" | "scenario";
  readonly sourceHost?: string;
  readonly sourceDigest: string;
} {
  const sourceKind = source.type;
  if (source.type === "https-git") {
    let sourceHost: string | undefined;
    try { sourceHost = new URL(source.value).hostname.toLowerCase(); } catch { sourceHost = undefined; }
    return {
      sourceKind,
      ...(sourceHost === undefined ? {} : { sourceHost }),
      sourceDigest: digest(`https-git:${source.value}`),
    };
  }
  return { sourceKind, sourceDigest: digest(`${source.type}:${source.value}`) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure<T = never>(code: SkillActionError["code"], message: string): SkillActionResult<T> {
  return { ok: false, error: { code, message } };
}
