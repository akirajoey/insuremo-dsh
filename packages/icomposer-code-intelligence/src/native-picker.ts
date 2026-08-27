/**
 * Host-only native file chooser adapter.  The directory chooser is supplied by
 * the Harness directory-picker seam; files use the same argv-only command
 * boundary as the Harness native picker package.
 */

export type NativePickerKind = "file" | "directory";
export type NativeCommandRunner = (command: string, args: readonly string[], signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
export interface NativeFilePickerInternals {
  readonly platform?: NodeJS.Platform;
  readonly run?: NativeCommandRunner;
  /** Optional host-only initial directory; never leaves the native process. */
  readonly defaultDirectory?: string;
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, "");
  return path === "" ? null : path;
}
function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}
function errorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}
function cancellation(error: unknown, platform: NodeJS.Platform): boolean {
  const code = errorCode(error); if (code !== 1 && code !== "1") return false;
  return platform === "darwin" ? /(?:User canceled|-128)/i.test(errorStderr(error)) : true;
}
async function defaultRunner(command: string, args: readonly string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const module = await import("@deepseek-ai/dsh-native-command");
  return module.runNativeCommand(command, args, signal);
}

/**
 * Open a native single-file chooser.  The returned path is deliberately an
 * absolute host path only for the caller's short-lived containment check; it
 * must never be sent to a browser or persisted.
 */
export async function pickNativeFile(signal: AbortSignal, internals: NativeFilePickerInternals = {}): Promise<string | null> {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  const platform = internals.platform ?? process.platform;
  const run = internals.run ?? defaultRunner;
  const defaultDirectory = typeof internals.defaultDirectory === "string" && internals.defaultDirectory.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(internals.defaultDirectory) ? internals.defaultDirectory.replace(/\\+$/, "") : undefined;
  if (platform === "darwin") {
    try {
      const prompt = defaultDirectory === undefined ? 'set selectedFile to choose file with prompt "Select Workspace File"' : `set selectedFile to choose file with prompt "Select Workspace File" default location POSIX file "${defaultDirectory.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const result = await run("osascript", ["-e", prompt, "-e", "POSIX path of selectedFile"], signal);
      return outputPath(result.stdout);
    } catch (error: unknown) {
      if (cancellation(error, platform)) return null;
      throw error;
    }
  }
  if (platform === "linux") {
    try {
      const result = await run("zenity", ["--file-selection", "--title=Select Workspace File", ...(defaultDirectory === undefined ? [] : [`--filename=${defaultDirectory}/`])], signal);
      return outputPath(result.stdout);
    } catch (error: unknown) {
      if (cancellation(error, platform)) return null;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try {
      const result = await run("kdialog", ["--getopenfilename", defaultDirectory ?? ".", "--title", "Select Workspace File"], signal);
      return outputPath(result.stdout);
    } catch (error: unknown) {
      if (cancellation(error, platform)) return null;
      if (errorCode(error) === "ENOENT") throw new Error("no supported native file picker found (install zenity or kdialog)");
      throw error;
    }
  }
  throw new Error(`native file picker is unsupported on ${platform}`);
}
