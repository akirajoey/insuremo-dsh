/** Diagnosis hand-off choreography (TASK-088): assemble the localized
 * diagnosis text from the host `imo-diagnosis` payload, then deliver it into
 * the dedicated persistent "install diagnostics" Workspace using ONLY
 * unmodified official rc.7 plugin seams — `workspaces.create` (idempotent by
 * path), `workspaces.connectWorkspace` (blank-session reuse), and
 * `sessions.open` — plus the session-scope `inputActions.setDraft` standard
 * kit for prefill. No DSH patch is involved: no scratch marker, no staged
 * session drafts, and no Workspace-less session is ever created, so a
 * failure can never land the user in an inert Ungrouped composer.
 * TASK-086 carries over: every label follows the Settings locale through the
 * card's own translator seat; raw material (commands, operation ids,
 * stdout/stderr, error code/message, environment values) is never translated
 * or altered. */

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
  /** Host-computed install-diagnostics directory (TASK-088). */
  readonly diagnosisCwd?: string;
}

/** The narrow sessions face the hand-off needs (official rc.7 ISessions). */
export interface DiagnosisSessions {
  open(id: string): void;
}

/** One workspace row as the hand-off reads it (official rc.7 WorkspaceView). */
export interface DiagnosisWorkspaceRow {
  readonly workspaceId: string;
  readonly path?: string;
}

/**
 * The narrow workspaces face the hand-off needs — every member is an
 * unmodified official rc.7 `IWorkspaces` contract method. `list` reads the
 * standard feed snapshot; `create` is documented idempotent by path;
 * `connectWorkspace` reuses the workspace's blank session when one exists
 * (restart reuse) and mints a fresh one otherwise; `rename` personalizes the
 * persistent Workspace title once.
 */
export interface DiagnosisWorkspaces {
  readonly list: { getSnapshot(): { items: ReadonlyArray<DiagnosisWorkspaceRow> } };
  create(input: { path: string }): Promise<{ workspaceId: string }>;
  connectWorkspace(workspaceId: string): Promise<string>;
  rename?(workspaceId: string, title: string): Promise<unknown>;
}

/** Runtime faces the card hands to the hand-off (wired by apply; tests inject doubles). */
export interface DiagnosisFaces {
  readonly workspaces?: DiagnosisWorkspaces;
  readonly sessions?: DiagnosisSessions;
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

// ---------------------------------------------------------------------------
// Pending prefill registry (memory-only; consumed once; reactively notified).
//
// The card queues the assembled text under the opened session's id; the
// session-scope prefill slot entry (prefill-slot.tsx) is the single consumer:
// it writes through the official `inputActions.setDraft` kit only while the
// composer draft is empty (user-first: a non-empty draft drops the staged
// text — the visible copy button covers that case), and every queued text is
// consumed at most once. Keyed by session id, so switching sessions can
// never leak one session's diagnosis text into another. Queueing notifies
// subscribers, so an ALREADY-MOUNTED entry consumes immediately instead of
// waiting for its next render; settled outcomes flow back to the card so the
// status never claims "prefilled" when the draft was not written.
// ---------------------------------------------------------------------------

const pendingPrefills = new Map<string, string>();

/** Settled delivery outcome for one queued session text. */
export type DiagnosisPrefillOutcome = "written" | "dropped";

const settledPrefills = new Map<string, DiagnosisPrefillOutcome>();

const prefillListeners = new Set<() => void>();

function notifyPrefillListeners(): void {
  for (const listener of [...prefillListeners]) listener();
}

/** Subscribe to queue/settle changes; returns the disposer. */
export function subscribeDiagnosisPrefill(listener: () => void): () => void {
  prefillListeners.add(listener);
  return () => { prefillListeners.delete(listener); };
}

/** Queue the first-send diagnosis text for one session (overwrites a prior queue for the same id) and wake subscribers. */
export function queueDiagnosisPrefill(sessionId: string, text: string): void {
  pendingPrefills.set(sessionId, text);
  notifyPrefillListeners();
}

/** Test-only: observe the queue without consuming. */
export function peekDiagnosisPrefill(sessionId: string): string | undefined {
  return pendingPrefills.get(sessionId);
}

/**
 * Consume one session's queued diagnosis text. The text returns only when
 * the composer draft is empty; a non-empty draft (user typed first) consumes
 * and drops the queue entry so the user's own text is never overwritten, and
 * settles the outcome as "dropped" immediately.
 */
export function takeDiagnosisPrefill(sessionId: string, draftIsEmpty: boolean): string | undefined {
  const text = pendingPrefills.get(sessionId);
  if (text === undefined) return undefined;
  pendingPrefills.delete(sessionId);
  if (!draftIsEmpty) settledPrefills.set(sessionId, "dropped");
  notifyPrefillListeners();
  return draftIsEmpty ? text : undefined;
}

/** The entry records a successful `setDraft` write so the card can report the real outcome. */
export function settleDiagnosisPrefill(sessionId: string, outcome: DiagnosisPrefillOutcome): void {
  settledPrefills.set(sessionId, outcome);
  notifyPrefillListeners();
}

/**
 * Wait for one session's prefill outcome (or timeout). Never throws: a
 * timeout means the outcome is unknown — the caller falls back to the copy
 * hint instead of claiming a prefill that may not have landed.
 */
export function waitForDiagnosisPrefill(sessionId: string, timeoutMs: number): Promise<DiagnosisPrefillOutcome | "timeout"> {
  const settled = settledPrefills.get(sessionId);
  if (settled !== undefined) return Promise.resolve(settled);
  return new Promise(resolve => {
    let done = false;
    let dispose: (() => void) | undefined;
    const finish = (outcome: DiagnosisPrefillOutcome | "timeout"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dispose?.();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    dispose = subscribeDiagnosisPrefill(() => {
      const outcome = settledPrefills.get(sessionId);
      if (outcome !== undefined) finish(outcome);
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace ensure: find-by-path reuse, idempotent create, coalesced in-flight
// attempts, one-time friendly rename.
// ---------------------------------------------------------------------------

/** In-flight workspace creation keyed by cwd, so concurrent clicks coalesce into one create. */
const ensuringWorkspaces = new Map<string, Promise<string>>();

function findDiagnosisWorkspace(workspaces: DiagnosisWorkspaces, cwd: string): string | undefined {
  const items = workspaces.list.getSnapshot().items;
  return items.find(item => item.path === cwd)?.workspaceId;
}

/**
 * Resolve the dedicated install-diagnostics Workspace: reuse the workspace
 * already registered for `cwd` (restart reuse), else register it once.
 * Concurrent callers share one in-flight attempt; the Host's own create is
 * idempotent by path, so even a list-lag race cannot produce a duplicate.
 * The friendly title is applied once, best-effort, right after creation —
 * a reuse never renames, so a user's own title edit survives.
 */
export async function ensureDiagnosisWorkspace(workspaces: DiagnosisWorkspaces, cwd: string, title: string): Promise<string> {
  const existing = findDiagnosisWorkspace(workspaces, cwd);
  if (existing !== undefined) return existing;
  const inflight = ensuringWorkspaces.get(cwd);
  if (inflight !== undefined) return inflight;
  const attempt = (async () => {
    const created = await workspaces.create({ path: cwd });
    try {
      await workspaces.rename?.(created.workspaceId, title);
    } catch {
      // Non-fatal: the Workspace keeps the Host-derived directory basename.
    }
    return created.workspaceId;
  })().finally(() => { ensuringWorkspaces.delete(cwd); });
  ensuringWorkspaces.set(cwd, attempt);
  return attempt;
}

/** Best-effort clipboard write; `false` means the user must rely on the visible copy button. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Outcome of one diagnosis hand-off, driving the card's inline notice. */
export type DiagnosisHandoff =
  /** The dedicated Workspace session opened; the prefill outcome is pending —
   * the card awaits {@link waitForDiagnosisPrefill} before claiming success. */
  | { readonly kind: "opened"; readonly sessionId: string }
  | {
    readonly kind: "clipboard-only";
    readonly copied: boolean;
    /** Which official step failed — no session was created or opened either way. */
    readonly reason: "faces-unavailable" | "workspace-failed" | "connect-failed";
  };

/**
 * Open the dedicated diagnosis Workspace's session and queue the prefill.
 * Every step rides an unmodified official rc.7 seam; any failure falls back
 * to the clipboard WITHOUT creating or opening any session, so the user can
 * never be left in an inert Workspace-less composer. The target session id
 * is the value `connectWorkspace` RESOLVES (reuse or fresh — never guessed
 * from the current view). Never sends anything: the user reviews the
 * prefilled text, picks a model, and presses Enter.
 */
export async function handOffDiagnosis(
  text: string,
  diagnosisCwd: string,
  faces: DiagnosisFaces | undefined,
  workspaceTitle: string,
): Promise<DiagnosisHandoff> {
  const workspaces = faces?.workspaces;
  const sessions = faces?.sessions;
  if (workspaces === undefined || sessions === undefined) {
    return { kind: "clipboard-only", copied: await copyToClipboard(text), reason: "faces-unavailable" };
  }
  let workspaceId: string;
  try {
    workspaceId = await ensureDiagnosisWorkspace(workspaces, diagnosisCwd, workspaceTitle);
  } catch {
    return { kind: "clipboard-only", copied: await copyToClipboard(text), reason: "workspace-failed" };
  }
  let sessionId: string;
  try {
    sessionId = await workspaces.connectWorkspace(workspaceId);
  } catch {
    return { kind: "clipboard-only", copied: await copyToClipboard(text), reason: "connect-failed" };
  }
  queueDiagnosisPrefill(sessionId, text);
  sessions.open(sessionId);
  return { kind: "opened", sessionId };
}
