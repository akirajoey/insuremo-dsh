import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** Stable per-workspace directory under <DSH_HOME>/write (mirrors ici). */
export function writeBaseDir(canonicalPathInput: string, workspaceId: string): string {
  let canonicalPath = canonicalPathInput;
  try { canonicalPath = realpathSync(canonicalPathInput); } catch { /* keep */ }
  const hash = createHash("sha256").update(`${canonicalPath}:${workspaceId}`).digest("hex").slice(0, 16);
  return join(getDshHome(), "write", hash);
}

export interface TestArtifact {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly writtenAt: string;
  readonly evidence: {
    readonly elapsedMs: number;
    readonly httpStatus: number | null;
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly traceId: string;
    readonly testUrl: string;
    readonly savedAt: string;
  };
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly exitCode: number | null;
}

/**
 * Persist the allowlisted test evidence artifact under
 * `<DSH_HOME>/write/<hash>/artifacts/test-<operationId>.json`. The file
 * contains digests and bounded identifiers only — never raw payloads.
 */
export async function writeTestArtifact(baseDir: string, operationId: string, artifact: Omit<TestArtifact, "schemaVersion" | "operationId" | "writtenAt">): Promise<string> {
  const dir = join(baseDir, "artifacts");
  await mkdir(dir, { recursive: true });
  const full: TestArtifact = {
    schemaVersion: 1,
    operationId,
    writtenAt: new Date().toISOString(),
    ...artifact,
  };
  const path = join(dir, `test-${sanitizeFileToken(operationId)}.json`);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
  return path;
}

/** Read one test artifact back (evidence retrieval). */
export async function readTestArtifact(baseDir: string, operationId: string): Promise<TestArtifact | null> {
  try {
    const path = join(baseDir, "artifacts", `test-${sanitizeFileToken(operationId)}.json`);
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as TestArtifact;
    if (parsed.schemaVersion !== 1 || typeof parsed.operationId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Operation ids are UUIDs; keep a conservative charset for file names. */
function sanitizeFileToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "unknown";
}
void dirname;
