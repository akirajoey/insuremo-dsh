import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Which install/update family a captured failure belongs to. */
export type FailureKind = "imo-cli" | "skill";

/**
 * One captured failed install/update operation. Raw stdout/stderr survive in
 * memory only — never persisted, never journaled, never sent anywhere except
 * the `imo-diagnosis` action response — and a later success of the same kind
 * clears the slot.
 */
export interface FailureDiagnosis {
  readonly kind: FailureKind;
  /** Human-readable operation label, e.g. `imo-install` or `skill-install:scenario/ask-insuremo`. */
  readonly operation: string;
  /** Executed command lines, in order (registry values already constant). */
  readonly commands: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly packageManager?: "npm" | "pnpm";
  readonly registry?: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly occurredAt: string;
  /**
   * Structured failure reason (TASK-085): rides the imo-diagnosis payload to
   * the browser (a wire field, never a persisted event) so a run with no
   * streams at all — an unresolvable preview tool — is still diagnosable.
   * The message is redacted at capture time like the streams.
   */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Raw streams as captured for one failed run (pre-redaction, pre-clip). */
export interface FailureStreams {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutLossy: boolean;
  readonly stderrLossy: boolean;
}

/** Per-stream cap for stored diagnosis text (~256KB) with an explicit marker. */
export const DIAGNOSIS_STREAM_LIMIT_BYTES = 256 * 1024;

const TRUNCATION_MARKER = "\n[...output truncated]\n";

/**
 * Cap one captured stream at the diagnosis budget. `String.length` counts
 * UTF-16 code units, an over-approximation of UTF-8 bytes, so the clipped
 * text never exceeds the byte budget; the marker records the loss.
 */
export function clipDiagnosisStream(text: string): { text: string; truncated: boolean } {
  if (text.length <= DIAGNOSIS_STREAM_LIMIT_BYTES) return { text, truncated: false };
  return { text: text.slice(0, DIAGNOSIS_STREAM_LIMIT_BYTES) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Replace credential-shaped substrings with `***` sentinels so secrets never
 * leave the process inside a diagnosis payload: npm/yarn auth config values,
 * Authorization headers, URL userinfo, and common personal-token prefixes.
 * Surrounding context stays readable.
 */
export function redactSecrets(text: string): string {
  return text
    // _auth=… / _authToken=… (npmrc lines and `npm config` echoes, any quote style)
    .replace(/_auth(?:Token)?\s*[=:]\s*(?:"[^"\s]*"|'[^'\s]*'|[^\s&"'`]+)/gi, "_auth=***")
    // Authorization header shapes (verb preserved, value dropped)
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    // userinfo credentials inside URLs (registry mirrors often echo them)
    .replace(/(https?:\/\/)([^\s/@:"]+)?:([^\s/@"]+)@/g, "$1***:***@")
    // common personal-access-token prefixes (npm_, GitHub, OpenAI-style)
    .replace(/\b(?:npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g, "***");
}

/** Everything the store needs to build one diagnosis entry. */
export interface DiagnosisCapture {
  readonly kind: FailureKind;
  readonly operation: string;
  readonly commands: readonly string[];
  readonly exitCode: number | null;
  readonly streams: FailureStreams;
  readonly packageManager?: "npm" | "pnpm";
  readonly registry?: string;
  /** Structured failure reason; message is redacted before storage. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * In-memory last-failure store, one slot per kind. `record` overwrites,
 * `clear` implements success-clears, `snapshot` is the diagnosis read face.
 * Nothing here touches the operation log or any durable surface.
 */
export class FailureDiagnosisStore {
  readonly #last = new Map<FailureKind, FailureDiagnosis>();

  record(capture: DiagnosisCapture): FailureDiagnosis {
    const stdout = clipDiagnosisStream(redactSecrets(capture.streams.stdout));
    const stderr = clipDiagnosisStream(redactSecrets(capture.streams.stderr));
    const entry: FailureDiagnosis = {
      kind: capture.kind,
      operation: capture.operation,
      commands: capture.commands,
      exitCode: capture.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated || capture.streams.stdoutLossy,
      stderrTruncated: stderr.truncated || capture.streams.stderrLossy,
      ...(capture.packageManager === undefined ? {} : { packageManager: capture.packageManager }),
      ...(capture.registry === undefined ? {} : { registry: capture.registry }),
      ...(capture.error === undefined
        ? {}
        : { error: { code: capture.error.code, message: redactSecrets(capture.error.message) } }),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      occurredAt: new Date().toISOString(),
    };
    this.#last.set(capture.kind, entry);
    return entry;
  }

  /** Success of one kind clears only that kind's last failure. */
  clear(kind: FailureKind): void {
    this.#last.delete(kind);
  }

  snapshot(kind: FailureKind): FailureDiagnosis | undefined {
    return this.#last.get(kind);
  }

  /** Test-only full reset. */
  reset(): void {
    this.#last.clear();
  }
}

/** Process-wide store shared by the install/skill kernels and the action route. */
export const failureDiagnosis = new FailureDiagnosisStore();

/**
 * The harness home's scratch directory — the same `$DSH_HOME` (default
 * `~/.dsh`) the bootstrap resolves, plus the `scratch` segment the harness
 * uses for Workspace-less sessions. Computed on the Host because browser
 * clients cannot resolve host paths.
 */
export function scratchDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return resolve(configured === "" ? join(homedir(), ".dsh") : configured, "scratch");
}
