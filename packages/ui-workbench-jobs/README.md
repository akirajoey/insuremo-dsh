# `@icomposer/ui-workbench-jobs`

Client-side Workbench conversation contributions. The package keeps the
existing keyed `conversation.chat.node` projection for generic Harness jobs
and also owns the `tool.call.toolview` key `ici_explain`.

The ICI card is an interactive, localized Prepare → confirmation surface. A
single API result uses the existing job card; a `batch=<id> jobs=<n>` result
renders one card that confirms one reference/provider/model/not-before tuple
for all APIs. It offers separate native Host actions for a workspace-relative
supported text file or directory through same-origin routes (no in-card
tree/modal), defaults to `ref_doc`, and renders per-job statuses while the
scheduler drains the batch sequentially. Catalogued models use a full select;
providers with an unavailable/empty catalog still accept an opaque model ID.
Start sends only the safe relative reference target, consent, and model
selection; source contents are read by restricted Host-created Explain Agents,
never by the browser or the main session.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-workbench-jobs run test
pnpm --filter @icomposer/ui-workbench-jobs run bundle
```
