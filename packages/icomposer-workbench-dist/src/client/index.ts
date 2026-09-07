/**
 * Client aggregate entry for the distributable `@icomposer/workbench`
 * plugin: one closure-factory bundle registering the three Workbench UI
 * contributions (settings section, sidebar status badge, jobs conversation
 * node). Each sub-apply keeps its own locale/slot effect scoping — running
 * three applies over one ClientContext is exactly what three separate
 * bundles would do, minus two extra loader entries.
 */
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { apply as settingsApply, inject as settingsInject } from "../../../ui-insuremo-settings/src/client/index.ts";
import { apply as statusApply, inject as statusInject } from "../../../ui-insuremo-status/src/client/index.ts";
import { apply as jobsApply, inject as jobsInject } from "../../../ui-workbench-jobs/src/client/index.ts";

/**
 * Union of the three sub-plugins' client injects, derived from each
 * sub-plugin's own declaration so a new service requirement never drifts:
 * the loader provides every listed service up front and cordis guards any
 * undeclared ctx property access at runtime.
 */
export const inject = [...new Set([...settingsInject, ...statusInject, ...jobsInject])];

/** Register dictionaries + slot contributions for all three UI blocks. */
export function apply(ctx: ClientContext): void {
  settingsApply(ctx);
  statusApply(ctx);
  jobsApply(ctx);
}
