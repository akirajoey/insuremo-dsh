/**
 * Client aggregate entry for the distributable `@icomposer/workbench`
 * plugin: one closure-factory bundle registering the three Workbench UI
 * contributions (settings section, sidebar status badge, jobs conversation
 * node). Each sub-apply keeps its own locale/slot effect scoping — running
 * three applies over one ClientContext is exactly what three separate
 * bundles would do, minus two extra loader entries.
 */
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { apply as settingsApply } from "../../../ui-insuremo-settings/src/client/index.ts";
import { apply as statusApply } from "../../../ui-insuremo-status/src/client/index.ts";
import { apply as jobsApply } from "../../../ui-workbench-jobs/src/client/index.ts";

/** Union of the three sub-plugins' client injects. */
export const inject = ["slots", "locale", "sessions"];

/** Register dictionaries + slot contributions for all three UI blocks. */
export function apply(ctx: ClientContext): void {
  settingsApply(ctx);
  statusApply(ctx);
  jobsApply(ctx);
}
