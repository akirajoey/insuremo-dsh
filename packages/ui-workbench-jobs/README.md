# `@icomposer/ui-workbench-jobs`

Client-side Workbench conversation contributions. The package keeps the
existing keyed `conversation.chat.node` projection for generic Harness jobs
and also owns the `tool.call.toolview` key `ici_explain`.

The ICI card is an interactive, localized Prepare → confirmation surface. It
opens a workspace-only modal picker for workspace-relative supported text
files or directories through same-origin Host routes, defaults to `ref_doc`,
lets the user select an explicit provider/model and not-before time, and
renders scheduled/running/final/failed/interrupted states. Catalogued models
use a full select; providers with an unavailable/empty catalog still accept an
opaque model ID. Start sends only the safe relative reference target, consent,
and model selection; source contents are read by the restricted Host-created
Explain Agent, never by the browser or the main session.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-workbench-jobs run test
pnpm --filter @icomposer/ui-workbench-jobs run bundle
```
