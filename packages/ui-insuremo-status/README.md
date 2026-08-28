# `@icomposer/ui-insuremo-status`

Host/client Workbench plugin for the InsureMO sidebar status and owned brand
chrome. It keeps the footer driver hidden, overlays the Harness brand buttons
without changing their click/focus/tooltip owners, and ships source-derived
InsureMO artwork plus the lowercase `dsh` wordmark. Black ink follows
`body[data-ds-dark-theme]` immediately while the purple mark is retained.

The workspace health decorator is also fail-closed: undetected workspaces get
no host or glyphs; detected workspaces get the 16px iComposer, ICI Graph, and
ICI Explain state glyphs inline in the native workspace row. The read-only
status route is polled with bounded cleanup when rows disappear, rename, or
filter out.

The package does not probe credentials or own sidebar button actions. Live
status arrives from the Workbench overview endpoint; the native Harness
buttons remain the behavior owners.

The package uses the Harness Strategy A `clientBundle` preset, which keeps
React in the browser module table rather than copying it into `lib/client.js`.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-status run test
pnpm --filter @icomposer/ui-insuremo-status run bundle
```
