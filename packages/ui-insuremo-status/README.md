# `@icomposer/ui-insuremo-status`

Host/client Workbench plugin for the InsureMO sidebar status and brand
identity. The footer driver stays hidden; brand identity is contributed only
through the official `sidebar.brand.mark`, `sidebar.brand.name` and
`conversation.hero.brand.mark` slots (no host DOM overlay or modification).
The mark slot always draws the standalone globe; the name slot draws only the
lettering by cropping the fixed globe region from the owned combined PNG; the
hero keeps its own globe. These are independent public slots, so normal host
spacing applies and the result is intentionally not a pixel-identical copy of
the previous combined artwork. Black ink follows `body[data-ds-dark-theme]`
immediately while the purple mark is retained.

The workspace health decorator is also fail-closed: undetected workspaces get
no host or glyphs; detected workspaces get the 16px iComposer, ICI Graph, and
ICI Explain state glyphs inline in the native workspace row. The read-only
status route is polled with bounded cleanup when rows disappear, rename, or
filter out.

The package does not probe credentials or own sidebar button actions. Live
status arrives from the Workbench overview endpoint; the native Harness
buttons remain the behavior owners.

## Picker overlay and remaining boundary

The narrow-rail Picker renders through the official root/list `shell.overlay`
slot, outside the clipped sidebar. The footer and overlay entries share a
controller created by each client plugin apply and supplied through their slot
`inject` factories. A declared slot is not enough: the overlay component must
actually mount and acknowledge availability. On closure, target change, lost
slot or plugin unload, the Picker cancels its own request and discards stale
responses. Its frame-sized wrapper is click-through; the panel alone accepts
pointer events. Positioning measures only the plugin's trigger, panel and overlay
wrapper, clamps to the visible frame and responds to scroll/resize.

If the overlay is absent or not rendered, the wide Picker remains inline. The
narrow trigger instead explains that the user must **manually expand the
sidebar**; it does not claim a sidebar-opening API or offer a Settings fallback.
The Picker no longer creates a body portal or a separate React root.

The remaining `react-dom/client` use is `WorkspaceHealth`'s existing `createRoot`
(the accepted `EX-WH-01` workspace-row health driver, unchanged here). This
exception is not a claim of final DOM compliance. The status package's local
layout type-only shim is a build aid; the independent published-declaration
contract gate remains separate and is not replaced by it.

Real App page rendering, focus behaviour, frame clipping and visuals are **not
verified** here (no browser automation was available); jsdom/component geometry
tests do not stand in for a real UI check.

The package uses the Harness Strategy A `clientBundle` preset, which keeps
React in the browser module table rather than copying it into `lib/client.js`.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-status run test
pnpm --filter @icomposer/ui-insuremo-status run bundle
```
