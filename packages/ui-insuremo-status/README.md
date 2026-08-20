# `@icomposer/ui-insuremo-status`

Host/client Workbench plugin for the static InsureMO status placeholder in the
sidebar footer. Phase 1 renders a warning dot and the localized
`InsureMO · 未配置` / `InsureMO · Not configured` label. It does not probe an
environment or handle clicks; live status arrives in a later phase.

Phase 2 keeps this a static placeholder on purpose: turning the sidebar badge
into a live overall-status dot would require the status bundle to repeat the
overview fetch (duplicating cross-bundle network traffic and failure handling)
or to receive a projected overview through the slot seams, which is not wired
in this phase. The `@icomposer/ui-insuremo-settings` section owns the live
read-only overview instead; this package stays presentational.

The package uses the Harness Strategy A `clientBundle` preset, which keeps
React in the browser module table rather than copying it into `lib/client.js`.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-status run test
pnpm --filter @icomposer/ui-insuremo-status run bundle
```
