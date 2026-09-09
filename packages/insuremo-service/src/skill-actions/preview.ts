import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { Context } from "@deepseek-ai/cordis";
import { IMO_REGISTRY } from "../imo-install.ts";
import type { ImoSkillActivation, ImoSkillActivationSnapshot } from "../skill-activation.ts";
import { parseSkillCatalogOutput, SKILLS_TOOL_SOURCE } from "./catalog.ts";
import type { ImoSkills } from "../skills.ts";
import { digest, runCapture, runCaptureDetailed, type RunResult } from "../run.ts";
import { failureDiagnosis } from "../diagnosis.ts";
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

/** Read-only discovery argv for the trusted source; `-l` never mutates a store. */
export function skillCatalogArgs(): readonly string[] {
  return [
    "-y", `--registry=${SKILLS_TOOL_REGISTRY}`, SKILLS_TOOL_PACKAGE, "add", SKILLS_TOOL_SOURCE,
    "-l", "--skip-update-check",
  ];
}
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
    const previewArgs = installArgs(action, true);
    const run = await runCaptureDetailed(ctx.subprocess, {
      command,
      args: previewArgs,
      timeoutMs: config.timeoutMs,
      signal,
    });
    if (!run.ok) {
      // TASK-085: the dry-run failure IS the user-visible install failure —
      // the formal run is never reached, so the execution-path capture would
      // never fire. Record the real argv and redacted output at this source;
      // a later successful install clears the slot. An unresolvable preview
      // tool captures the structured reason with empty streams instead —
      // the failed button must always have a diagnosis to show.
      const unavailable = command === SKILLS_TOOL_COMMAND && run.error.code === "not-found";
      failureDiagnosis.record({
        kind: "skill",
        operation: skillDiagnosisOperation(action),
        commands: [`${command} ${previewArgs.join(" ")}`],
        exitCode: run.error.exitCode ?? null,
        streams: {
          stdout: run.detail?.stdout ?? "",
          stderr: run.detail?.stderr ?? "",
          stdoutLossy: run.detail?.stdoutLossy ?? false,
          stderrLossy: run.detail?.stderrLossy ?? false,
        },
        error: unavailable
          ? { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" }
          : { code: run.error.code, message: run.error.message },
      });
      return runFailure(run, command === SKILLS_TOOL_COMMAND);
    }
    const catalogInstall = action.kind === SKILL_INSTALL_KIND
      && action.source.type === "alias"
      && action.source.value === SKILLS_TOOL_SOURCE;
    if (catalogInstall) {
      if (run.value.stdout.truncated) return failure("catalog-unavailable", "the trusted Skills catalog could not be verified");
      const parsed = parseSkillCatalogOutput(run.value.stdout.text);
      if (!parsed.ok) return failure("catalog-unavailable", "the trusted Skills catalog could not be verified");
      const candidateNames = parsed.value.skills.map(entry => entry.name);
      if (action.skills.some(name => !candidateNames.includes(name))) {
        return failure("catalog-selection-invalid", "the selected Skill is not in the current trusted catalog");
      }
      return {
        ok: true,
        value: {
          kind: action.kind,
          scope: action.scope,
          before: before.value,
          activation: activationSnapshot,
          candidateNames,
          stdoutDigest: run.value.stdoutDigest,
        },
      };
    }
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
  const catalogInstall = action.kind === SKILL_INSTALL_KIND
    && action.source.type === "alias"
    && action.source.value === SKILLS_TOOL_SOURCE;
  return action.kind === SKILL_UPDATE_KIND
    || (action.kind === SKILL_INSTALL_KIND && (action.source.type === "scenario" || catalogInstall))
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
  if (source.type === "scenario" || (source.type === "alias" && source.value === SKILLS_TOOL_SOURCE)) {
    return [
      "-y", `--registry=${SKILLS_TOOL_REGISTRY}`, SKILLS_TOOL_PACKAGE, "add", SKILLS_TOOL_SOURCE, "-g", "-a", action.agent,
      ...(source.type === "scenario" ? ["-s", source.value] : action.skills.flatMap(skill => ["-s", skill])),
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

/** Diagnosis label for one action: kind plus the install source when present. */
export function skillDiagnosisOperation(action: NormalizedSkillAction): string {
  if (action.kind !== SKILL_INSTALL_KIND) return action.kind;
  return `skill-install:${action.source.type}/${action.source.value}`;
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
