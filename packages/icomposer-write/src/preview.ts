import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { buildPushArgs } from "./cli.ts";
import { capture, digest } from "./capture.ts";
import { parsePushOutput } from "./parse.ts";
import type { PushMode, PushPreviewView } from "./types.ts";

export interface PreviewDeps {
  readonly subprocess: SubprocessRuntime;
  readonly command: string;
  readonly timeoutMs: number;
  readonly canonicalPath: string;
  readonly authProfile: string;
  readonly workspaceId: string;
}

export type PreviewDepsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Run one bounded dry-run push preview inside an auth lease (never writes). */
export async function runPushPreview(deps: PreviewDeps, mode: PushMode, files: readonly string[], signal?: AbortSignal): Promise<PreviewDepsResult<PushPreviewView>> {
  const started = Date.now();
  const run = await capture(deps.subprocess, {
    command: deps.command,
    args: buildPushArgs(mode, deps.authProfile, files, { dryRun: true }),
    cwd: deps.canonicalPath,
    timeoutMs: deps.timeoutMs,
    signal,
  });
  if (!run.ok) return { ok: false, error: { code: run.error.code, message: run.error.code } };
  if (run.value.signal !== null) return { ok: false, error: { code: "command-failed", message: "command-failed" } };
  const parsed = parsePushOutput(run.value.stdout, files, files[0]);
  if (!parsed.ok) {
    if (run.value.exitCode !== 0) return { ok: false, error: { code: "command-failed", message: "command-failed" } };
    return { ok: false, error: { code: "parse-error", message: "parse-error" } };
  }
  const localVersions = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await readFile(join(deps.canonicalPath, file), "utf8");
      localVersions.set(file, digest(content));
    } catch {
      localVersions.set(file, "");
    }
  }
  const withLocal = parsed.value.files.map((file, index) => ({
    ...file,
    localVersion: localVersions.get(file.file) ?? localVersions.get(files[index]) ?? "",
  }));
  const view: PushPreviewView = {
    workspaceId: deps.workspaceId,
    mode,
    files: withLocal as unknown as PushPreviewView["files"],
    conflictFiles: parsed.value.conflict ? withLocal.filter(f => f.conflict).map(f => f.file) : [],
    count: parsed.value.files.length,
    truncated: parsed.value.files.length >= 200,
    durationMs: Date.now() - started,
    stdoutDigest: run.value.stdoutDigest,
  };
  return { ok: true, value: view };
}

