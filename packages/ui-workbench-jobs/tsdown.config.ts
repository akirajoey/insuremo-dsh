import { clientBundle } from "../../../deepseek-harness/packages/client/tsdown.client.ts";

/** Strategy A: reuse the Harness clientBundle closure-factory preset. */
export default clientBundle("@icomposer/ui-workbench-jobs", ["src/index.ts"]);
