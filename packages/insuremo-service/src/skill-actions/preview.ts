import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { Context } from "@deepseek-ai/cordis";
import { IMO_REGISTRY } from "../imo-install.ts";
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

/** Unpinned package by explicit product decision; registry is the shared trusted constant. */
export const SKILLS_TOOL_COMMAND = "npx" as const;
export const SKILLS_TOOL_PACKAGE = "@insuremo/skills-tool" as const;
export const SKILLS_TOOL_REGISTRY: string = IMO_REGISTRY;
const MAX_PREVIEW_NAMES = 100;
const ANSI_ESCAPE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Z])/gu;
const BOX_DECORATION = /[┌┐└┘─━│┃┏┓┗┛╭╮╰╯═║╔╗╚╝╴╵╶╷]/gu;

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
    const command = actionCommand(action, config.command);
    const run = await runCapture(ctx.subprocess, {
      command,
      args: installArgs(action, true),
      timeoutMs: config.timeoutMs,
      signal,
    });
    if (!run.ok) return runFailure(run, command === SKILLS_TOOL_COMMAND);
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

export function actionCommand(action: NormalizedSkillAction, defaultCommand: string): string {
  return action.kind === SKILL_UPDATE_KIND || (action.kind === SKILL_INSTALL_KIND && action.source.type === "scenario")
    ? SKILLS_TOOL_COMMAND
    : defaultCommand;
}

export function executionArgs(action: NormalizedSkillAction): readonly string[] {
  if (action.kind === SKILL_INSTALL_KIND) return installArgs(action, false);
  if (action.kind === SKILL_REMOVE_KIND) return ["skills", "remove", ...action.names, "-g", "-a", action.agent, "-y"];
  if (action.kind === SKILL_UPDATE_KIND) return ["-y", `--registry=${SKILLS_TOOL_REGISTRY}`, SKILLS_TOOL_PACKAGE, "update", "-g", "--skip-update-check"];
  return [];
}

export function installArgs(action: NormalizedInstallAction, preview: boolean): readonly string[] {
  const source = action.source;
  if (source.type === "scenario") {
    return [
      "-y", `--registry=${SKILLS_TOOL_REGISTRY}`, SKILLS_TOOL_PACKAGE, "add", "insuremo-skills", "-g", "-a", action.agent, "-s", source.value,
      ...(preview ? ["-l"] : ["-y"]), "--skip-update-check",
    ];
  }
  const sourceArgs = source.type === "npm" ? ["--from-npm", source.value] : [source.value];
  return [
    "skills", "install", ...sourceArgs,
    "-g", "-a", action.agent,
    ...action.skills.flatMap(skill => ["-s", skill]),
    ...(preview ? ["--list"] : ["-y"]),
  ];
}

export function parsePreviewNames(output: string): readonly string[] {
  const names = new Set<string>();
  try {
    collectNames(JSON.parse(output), names);
  } catch {
    // `skills-tool` currently emits ANSI/table output. Only the first field of
    // each row is considered, and only strict kebab-case names survive.
    for (const line of stripDecorations(output).split(/\r?\n/u)) {
      if (names.size >= MAX_PREVIEW_NAMES) break;
      const cells = line.split(/[|│┃║]/u).map(cell => cell.trim()).filter(Boolean);
      const first = cells[0] ?? line.trim();
      const labeled = first.match(/^(?:name|skill)\s*[:=]\s*([^\s]+)/iu)?.[1];
      const token = labeled ?? first.replace(/^(?:[-*•✓✔→»›]\s*|\d+[.)]\s*)+/u, "").trim().match(/^([^\s]+)/u)?.[1];
      if (token !== undefined && isSkillName(token)) names.add(token);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function stripDecorations(output: string): string {
  return output
    .replace(ANSI_ESCAPE, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(BOX_DECORATION, " ");
}

function collectNames(value: unknown, names: Set<string>): void {
  if (names.size >= MAX_PREVIEW_NAMES) return;
  if (typeof value === "string") {
    if (isSkillName(value)) names.add(value);
    return;
  }
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

function runFailure(run: Exclude<RunResult, { ok: true }>, skillsTool: boolean): SkillActionResult<never> {
  const error = run.error;
  const unavailable = skillsTool && error.code === "not-found";
  return {
    ok: false,
    error: {
      code: unavailable ? "tool-unavailable" : error.code as SkillActionError["code"],
      message: unavailable ? "npx is unavailable; install Node.js/npm to sync Skills" : error.message,
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
