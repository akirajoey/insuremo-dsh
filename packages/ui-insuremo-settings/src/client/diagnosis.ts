/** Diagnosis-session choreography (TASK-083): assemble the localized
 * diagnosis text from the host `imo-diagnosis` payload, then stage it into a
 * fresh ungrouped scratch session. Ordering is a hard constraint from the
 * harness client runtime (TASK-082): create → setDraft → open. The staging
 * API is feature-detected so the card degrades on runtimes without it
 * (Desktop rc.7): the text goes to the clipboard with a paste hint instead,
 * and the ungrouped session still opens when creation is available.
 * TASK-086: every label follows the Settings locale through the card's own
 * translator seat; raw material (commands, operation ids, stdout/stderr,
 * error code/message, environment values) is never translated or altered. */

import type { InsuremoLocaleKey } from "./locales.ts";

/** The translator seat the card already receives (PropsLocale). */
export type DiagnosisTranslate = (key: InsuremoLocaleKey) => string;

export interface DiagnosisActionPayload {
  readonly available: boolean;
  readonly diagnosis?: {
    readonly kind: string;
    readonly operation: string;
    readonly commands: readonly string[];
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
    readonly packageManager?: string;
    readonly registry?: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly occurredAt: string;
    /** Structured failure reason (no-stream runs like an unresolvable tool). */
    readonly error?: { readonly code: string; readonly message: string };
  };
  readonly scratchCwd?: string;
}

/** The narrow sessions face the card consumes (feature-detected members). */
export interface DiagnosisSessions {
  open(id: string): void
  create?(opts: { cwd: string }): Promise<string>
  setDraft?(id: string, text: string): void
}

/** Human label for an operation; scenario/source installs carry a suffix. */
function operationLabel(operation: string, t: DiagnosisTranslate): string {
  if (operation === "imo-install") return t("diagOpImoInstall");
  if (operation === "imo-upgrade") return t("diagOpImoUpgrade");
  if (operation === "skill-update") return t("diagOpSkillUpdate");
  if (operation === "skill-install") return t("diagOpSkillInstall");
  if (operation.startsWith("skill-install:")) return t("diagOpSkillInstallSource");
  return operation;
}

/** One rendered command line with its step number. */
function commandLines(commands: readonly string[], t: DiagnosisTranslate): string {
  if (commands.length === 0) return t("diagNoCommands");
  return commands.map((command, index) => `${index + 1}. ${command}`).join("\n");
}

/** Assemble the localized diagnosis text the user reviews and sends. */
export function buildDiagnosisText(diagnosis: NonNullable<DiagnosisActionPayload["diagnosis"]>, t: DiagnosisTranslate): string {
  const scene = operationLabel(diagnosis.operation, t);
  const environment = [
    `node: ${diagnosis.nodeVersion}`,
    `os: ${diagnosis.platform} ${diagnosis.arch}`,
    ...(diagnosis.packageManager === undefined ? [] : [`packageManager: ${diagnosis.packageManager}`]),
    ...(diagnosis.registry === undefined ? [] : [`registry: ${diagnosis.registry}`]),
  ].join("\n");
  return [
    diagnosis.kind === "imo-cli" ? t("diagTitleImo") : t("diagTitleSkill"),
    `${t("diagSceneLabel")}${scene}${t("diagParenOpen")}${diagnosis.operation}${t("diagParenClose")}`,
    `${t("diagOccurredAtLabel")}${diagnosis.occurredAt}`,
    "",
    t("diagCommandsLabel"),
    commandLines(diagnosis.commands, t),
    "",
    `exitCode: ${diagnosis.exitCode ?? t("diagNotRun")}`,
    ...(diagnosis.error === undefined ? [] : [`${t("diagErrorLabel")}${diagnosis.error.code}: ${diagnosis.error.message}`]),
    "",
    "stdout：",
    "```",
    diagnosis.stdout === "" ? t("diagEmpty") : diagnosis.stdout,
    "```",
    ...(diagnosis.stdoutTruncated ? [t("diagStdoutTruncated")] : []),
    "",
    "stderr：",
    "```",
    diagnosis.stderr === "" ? t("diagEmpty") : diagnosis.stderr,
    "```",
    ...(diagnosis.stderrTruncated ? [t("diagStderrTruncated")] : []),
    "",
    t("diagEnvironmentLabel"),
    environment,
    "",
    t("diagClosing"),
  ].join("\n");
}

/** Whether the running client runtime exposes the draft-staging API (≥ TASK-082). */
export function supportsDraftStaging(
  sessions: DiagnosisSessions | undefined,
): sessions is DiagnosisSessions & {
  create: (opts: { cwd: string }) => Promise<string>
  setDraft: (id: string, text: string) => void
} {
  return sessions !== undefined && typeof sessions.setDraft === "function" && typeof sessions.create === "function";
}

/** Outcome of one diagnosis hand-off, driving the card's inline notice. */
export type DiagnosisHandoff =
  | { readonly kind: "staged" }
  | { readonly kind: "copied" }
  | { readonly kind: "clipboard-only" };

/**
 * Open the diagnosis session in the mandated order, or fall back to the
 * clipboard when the runtime predates draft staging. Never sends anything:
 * the user reviews the prefilled text and presses Enter.
 */
export async function handOffDiagnosis(
  text: string,
  scratchCwd: string,
  sessions: DiagnosisSessions | undefined,
): Promise<DiagnosisHandoff> {
  if (supportsDraftStaging(sessions)) {
    const sessionId = await sessions.create({ cwd: scratchCwd });
    sessions.setDraft(sessionId, text);
    sessions.open(sessionId);
    return { kind: "staged" };
  }
  if (sessions !== undefined && typeof sessions.create === "function") {
    // Clipboard first: the text survives even if the session hand-off fails.
    await navigator.clipboard.writeText(text);
    const sessionId = await sessions.create({ cwd: scratchCwd });
    sessions.open(sessionId);
    return { kind: "copied" };
  }
  await navigator.clipboard.writeText(text);
  return { kind: "clipboard-only" };
}
