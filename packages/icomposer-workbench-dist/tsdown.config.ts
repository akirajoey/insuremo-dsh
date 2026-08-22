import { clientBundle } from "../../../deepseek-harness/packages/client/tsdown.client.ts";

/**
 * Distributable bundle: lib/index.js (host aggregate, @deepseek-ai/* and
 * react external as peers; @icomposer/* + zod inlined) and lib/client.js
 * (closure-factory client aggregate for the three UI blocks).
 */
export default clientBundle("@icomposer/workbench", ["src/index.ts"], {
  hostPhase: true,
});
