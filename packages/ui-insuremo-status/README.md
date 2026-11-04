# `@icomposer/ui-insuremo-status`

Host/client Workbench plugin for the InsureMO sidebar status and brand
identity. The footer driver stays hidden; brand identity is contributed only
through the official `sidebar.brand.mark`, `sidebar.brand.name` and
`conversation.hero.brand.mark` slots (no host DOM overlay or modification).
It ships source-derived InsureMO artwork plus the lowercase `dsh` wordmark.
Black ink follows `body[data-ds-dark-theme]` immediately while the purple mark
is retained.

The workspace health decorator is also fail-closed: undetected workspaces get
no host or glyphs; detected workspaces get the 16px iComposer, ICI Graph, and
ICI Explain state glyphs inline in the native workspace row. The read-only
status route is polled with bounded cleanup when rows disappear, rename, or
filter out.

The package does not probe credentials or own sidebar button actions. Live
status arrives from the Workbench overview endpoint; the native Harness
buttons remain the behavior owners.

## TASK-168a transitional boundaries

- The Picker still renders its floating rail panel through a **component-owned
  body portal** (`ProfilePicker.tsx` `createPortal`). This is a documented
  transition: TASK-173 will replace it with the official `shell.overlay`.
  **This card does not claim final DOM compliance.**
- The only `react-dom` call sites are that Picker portal and
  `WorkspaceHealth`'s `createRoot` (the accepted `EX-WH-01` workspace-row health
  driver, unchanged by this card).
- Real page rendering, focus behaviour and visuals are **not verified** here
  (no browser automation was available); jsdom component tests do not stand in
  for the real UI.

The package uses the Harness Strategy A `clientBundle` preset, which keeps
React in the browser module table rather than copying it into `lib/client.js`.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-status run test
pnpm --filter @icomposer/ui-insuremo-status run bundle
```
