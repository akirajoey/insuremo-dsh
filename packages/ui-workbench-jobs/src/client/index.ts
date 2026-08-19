import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { JobNode, type JobNodeProps } from "./JobNode.tsx";
import { en, zh, type WorkbenchJobLocaleKey } from "./locales.ts";
import type { WorkbenchJobData, WorkbenchJobStatus } from "./job-data.ts";

export type { JobNodeProps } from "./JobNode.tsx";
export type { WorkbenchJobData, WorkbenchJobStatus } from "./job-data.ts";
export type { WorkbenchJobLocaleKey } from "./locales.ts";

/** Locale namespace contributed by the Workbench job conversation node. */
export const NS = "conversation.workbenchJob";

declare module "@deepseek-ai/dsh-client-ui-conversation/client" {
  interface ChatNodeDataMap {
    "workbench-job": WorkbenchJobData;
  }
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "conversation.workbenchJob": WorkbenchJobLocaleKey;
  }
}

/**
 * Runtime services required by the keyed render contribution. The current
 * phase consumes future node data through props; sessions remains an explicit
 * dependency so the jobs mirror is available when host node assembly lands.
 */
export const inject = ["slots", "locale", "sessions"];

/** Register dictionaries and the keyed renderer; no local job state is kept. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-workbench-jobs: dictionaries");
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "workbench-job",
    locale: NS,
  }, JobNode));
}
