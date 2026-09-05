/** Diagnosis-session choreography (TASK-083): assemble the Chinese diagnosis
 * text from the host `imo-diagnosis` payload, then stage it into a fresh
 * ungrouped scratch session. Ordering is a hard constraint from the harness
 * client runtime (TASK-082): create → setDraft → open. The staging API is
 * feature-detected so the card degrades on runtimes without it (Desktop
 * rc.7): the text goes to the clipboard with a paste hint instead, and the
 * ungrouped session still opens when creation is available. */

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
  };
  readonly scratchCwd?: string;
}

/** The narrow sessions face the card consumes (feature-detected members). */
export interface DiagnosisSessions {
  open(id: string): void
  create?(opts: { cwd: string }): Promise<string>
  setDraft?(id: string, text: string): void
}

const OPERATION_LABELS: Record<string, string> = {
  "imo-install": "IMO CLI 一键安装",
  "imo-upgrade": "IMO CLI 更新",
  "skill-update": "Skills 全量更新",
};

/** One rendered command line with its step number. */
function commandLines(commands: readonly string[]): string {
  if (commands.length === 0) return "（无已执行命令记录）";
  return commands.map((command, index) => `${index + 1}. ${command}`).join("\n");
}

/** Assemble the Chinese diagnosis text the user reviews and sends. */
export function buildDiagnosisText(diagnosis: NonNullable<DiagnosisActionPayload["diagnosis"]>): string {
  const scene = OPERATION_LABELS[diagnosis.operation] ?? diagnosis.operation;
  const kindLabel = diagnosis.kind === "imo-cli" ? "IMO CLI" : "Skills";
  const environment = [
    `node: ${diagnosis.nodeVersion}`,
    `os: ${diagnosis.platform} ${diagnosis.arch}`,
    ...(diagnosis.packageManager === undefined ? [] : [`packageManager: ${diagnosis.packageManager}`]),
    ...(diagnosis.registry === undefined ? [] : [`registry: ${diagnosis.registry}`]),
  ].join("\n");
  return [
    `${kindLabel}安装/更新失败诊断`,
    `场景：${scene}（${diagnosis.operation}）`,
    `发生时间：${diagnosis.occurredAt}`,
    "",
    "执行的命令：",
    commandLines(diagnosis.commands),
    "",
    `exitCode: ${diagnosis.exitCode ?? "（未运行）"}`,
    "",
    "stdout：",
    "```",
    diagnosis.stdout === "" ? "（空）" : diagnosis.stdout,
    "```",
    ...(diagnosis.stdoutTruncated ? ["（stdout 已截断）"] : []),
    "",
    "stderr：",
    "```",
    diagnosis.stderr === "" ? "（空）" : diagnosis.stderr,
    "```",
    ...(diagnosis.stderrTruncated ? ["（stderr 已截断）"] : []),
    "",
    "环境信息：",
    environment,
    "",
    "请分析失败原因并给出修复步骤。",
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
