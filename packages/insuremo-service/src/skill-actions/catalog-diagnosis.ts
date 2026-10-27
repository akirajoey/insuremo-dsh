import { failureDiagnosis } from "../diagnosis.ts";
import type { RunSuccess } from "../run.ts";
import { SKILLS_TOOL_COMMAND, SKILLS_TOOL_REGISTRY } from "./tool.ts";

type CatalogRejection = "truncated" | "empty" | "format" | "oversized" | "selection-mismatch";

/** A CLI may exit zero yet return an unusable catalog: keep that failure diagnosable too. */
export function recordRejectedSkillCatalog(
  operation: string,
  args: readonly string[],
  run: RunSuccess,
  reason: CatalogRejection,
): void {
  failureDiagnosis.record({
    kind: "skill",
    operation,
    commands: [`${SKILLS_TOOL_COMMAND} ${args.join(" ")}`],
    exitCode: run.exitCode,
    streams: {
      stdout: run.stdout.text,
      stderr: run.stderr.text,
      stdoutLossy: run.stdout.truncated,
      stderrLossy: run.stderr.truncated,
    },
    registry: SKILLS_TOOL_REGISTRY,
    error: {
      code: reason === "selection-mismatch" ? "catalog-selection-invalid" : "catalog-unavailable",
      message: `Skills catalog verification failed (${reason})`,
    },
  });
}
