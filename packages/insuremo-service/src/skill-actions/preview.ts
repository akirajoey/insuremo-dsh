import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { Context } from "@deepseek-ai/cordis";
import type { ImoSkillActivation, ImoSkillActivationSnapshot } from "../skill-activation.ts";
import type { ImoSkills } from "../skills.ts";
import { digest, runCapture, type RunResult } from "../run.ts";
import { snapshotInventory } from "./diff.ts";
import {
  SKILL_ACTIVATION_KIND,
  SKILL_INSTALL_KIND,
  SKILL_REMOVE_KIND,
  SKILL_UPDATE_KIND,
  type NormalizedInstallAction,
  type NormalizedSkillAction,
  type SkillActionConfig,
  type SkillActionError,
  type SkillActionPreview,
  type SkillActionResult,
} from "./types.ts";

export async function previewSkillAction(
  ctx: Context,
  skills: ImoSkills,
  activation: ImoSkillActivation,
  action: NormalizedSkillAction,
  config: SkillActionConfig,
  signal?: AbortSignal,
): Promise<SkillActionResult<SkillActionPreview>> {
  const before = await snapshotInventory(skills, signal);
  if (!before.ok) return before;
  const activationSnapshot = await activation.snapshot(before.value.names);
  if (activationSnapshot === undefined) return failure("pre-check-failed", "skill activation state is unavailable");
  if (action.kind === SKILL_INSTALL_KIND) {
    const run = await runCapture(ctx.subprocess, {
      command: config.command,
      args: installArgs(action, true),
      timeoutMs: config.timeoutMs,
      signal,
    });
    if (!run.ok) return runFailure(run);
    const candidateNames = parsePreviewNames(run.value.stdout.text);
    return { ok: true, value: { kind: action.kind, scope: action.scope, before: before.value, activation: activationSnapshot, candidateNames, stdoutDigest: run.value.stdoutDigest } };
  }
  if (action.kind === SKILL_REMOVE_KIND) {
    const missing = action.names.find(name => !before.value.names.includes(name));
    if (missing !== undefined) return failure("not-installed", `skill '${missing}' is not installed`);
    return { ok: true, value: { kind: action.kind, scope: action.scope, before: before.value, activation: activationSnapshot, names: action.names } };
  }
  if (action.kind === SKILL_UPDATE_KIND) {
    return { ok: true, value: { kind: action.kind, scope: action.scope, before: before.value, activation: activationSnapshot } };
  }
  if (!before.value.names.includes(action.name)) return failure("not-installed", `skill '${action.name}' is not installed`);
  return {
    ok: true,
    value: { kind: action.kind, scope: action.scope, before: before.value, activation: activationSnapshot },
  };
}

export function executionArgs(action: NormalizedSkillAction): readonly string[] {
  if (action.kind === SKILL_INSTALL_KIND) return installArgs(action, false);
  if (action.kind === SKILL_REMOVE_KIND) return ["skills", "remove", ...action.names, "-g", "-a", action.agent, "-y"];
  if (action.kind === SKILL_UPDATE_KIND) return ["skills", "update", "--all"];
  return [];
}

export function installArgs(action: NormalizedInstallAction, preview: boolean): readonly string[] {
  const source = action.source;
  const sourceArgs = source.type === "scenario"
    ? ["--scenario", source.value]
    : source.type === "npm"
      ? ["--from-npm", source.value]
      : [source.value];
  return [
    "skills", "install", ...sourceArgs,
    "-g", "-a", action.agent,
    ...action.skills.flatMap(skill => ["-s", skill]),
    ...(preview ? ["--list"] : ["-y"]),
  ];
}

function parsePreviewNames(output: string): readonly string[] {
  const names = new Set<string>();
  try {
    collectNames(JSON.parse(output), names);
  } catch {
    // The CLI's human preview is also accepted, but only name-shaped tokens
    // are retained and no raw line ever crosses the service boundary.
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:[-*•]\s*)?([A-Za-z0-9][A-Za-z0-9_.@/-]{0,199})(?:\s+-.*)?$/);
      if (match !== null && isSkillName(match[1]!)) names.add(match[1]!);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function collectNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (typeof name === "string" && isSkillName(name)) names.add(name);
  for (const key of ["skills", "candidates", "items", "available"]) collectNames(record[key], names);
}

function runFailure(run: Exclude<RunResult, { ok: true }>): SkillActionResult<never> {
  const error = run.error;
  return {
    ok: false,
    error: {
      code: error.code as SkillActionError["code"],
      message: error.message,
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      ...(error.signal === undefined ? {} : { signal: error.signal }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
      ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
    },
  };
}

function failure<T = never>(code: SkillActionError["code"], message: string): SkillActionResult<T> {
  return { ok: false, error: { code, message } };
}
