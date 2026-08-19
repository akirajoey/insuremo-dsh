import type { JobView } from "@deepseek-ai/dsh-client-runtime/client";

/** Four-state presentation projection owned by the Workbench node. */
export type WorkbenchJobStatus = "queued" | "running" | "done" | "failed";

/** Digest-only data carried by a Chat node; no job payload or mutable state. */
export interface WorkbenchJobData {
  readonly jobId: string;
  readonly kindLabel: string;
  readonly status: WorkbenchJobStatus;
  readonly progressDigest?: string;
}

/**
 * Project one Harness jobs mirror row into the stable Chat-node payload.
 * Stopping/killed are terminal producer details but remain failed at this
 * presentation layer; a future producer may pass `queued` directly.
 */
export function projectJobView(job: JobView): WorkbenchJobData {
  const status: WorkbenchJobStatus = job.status === "running" || job.status === "stopping"
    ? "running"
    : job.status === "completed"
      ? "done"
      : "failed";
  return {
    jobId: String(job.id),
    kindLabel: job.label || job.kind,
    status,
  };
}
