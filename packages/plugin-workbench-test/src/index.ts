import { NoopWorkbenchTestProvider } from "./provider.ts";
import {
  WORKBENCH_TEST_READY_EVENT,
  WORKBENCH_TEST_SERVICE,
  type WorkbenchHostContext,
} from "./types.ts";

export type * from "./types.ts";
export { NoopWorkbenchTestProvider } from "./provider.ts";

/** Loader-facing plugin name. */
export const name = "@icomposer/plugin-workbench-test";

/** Register the no-op Service Provider and announce its readiness. */
export function apply(ctx: WorkbenchHostContext): void {
  const provider = new NoopWorkbenchTestProvider();
  ctx.provide(WORKBENCH_TEST_SERVICE, provider);
  ctx.emit(WORKBENCH_TEST_READY_EVENT, { provider: provider.provider });
  ctx.effect(() => () => provider.dispose(), "workbench-test.provider");
}
