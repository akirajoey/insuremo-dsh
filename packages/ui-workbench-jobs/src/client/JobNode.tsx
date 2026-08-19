import type { ReactNode } from "react";
import {
  IconApiOutline14,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkbenchJobData, WorkbenchJobStatus } from "./job-data.ts";
import type { WorkbenchJobLocaleKey } from "./locales.ts";
import css from "./JobNode.module.css";

/** Full props for the keyed conversation Chat-node renderer. */
export type JobNodeProps = PropsRuntime<"conversation.chat.node", "workbench-job">
  & PropsLocale<"conversation.workbenchJob">;

function dotState(status: WorkbenchJobStatus): StateDotState {
  switch (status) {
    case "queued": return "warning";
    case "running": return "ongoing";
    case "done": return "done";
    case "failed": return "error";
  }
}

/** Render one read-only Workbench job row in the conversation flow. */
export function JobNode({ node, t }: JobNodeProps): ReactNode {
  const data = node.data as WorkbenchJobData;
  const status = t(`status.${data.status}` as WorkbenchJobLocaleKey);
  return (
    <div className={css.row} data-job-id={data.jobId} data-job-status={data.status}>
      <IconApiOutline14 className={css.icon} size={14} aria-hidden="true" />
      <span className={css.kind}>{data.kindLabel}</span>
      <span className={css.status} role="status" aria-label={status}>
        <StateDot state={dotState(data.status)} />
        {status}
      </span>
      {data.progressDigest !== undefined && (
        <span className={css.digest}>{data.progressDigest}</span>
      )}
    </div>
  );
}
