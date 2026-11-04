# `@icomposer/ui-insuremo-status`

Host/client Workbench plugin for the InsureMO sidebar status and brand
identity. The footer driver stays hidden; brand identity is contributed only
through the official `sidebar.brand.mark`, `sidebar.brand.name` and
`conversation.hero.brand.mark` slots (no host DOM overlay or modification).
The wide row shows the complete owned logo through `sidebar.brand.name` at its
historical 99×24 size. A per-apply signal shared by the two real slot inject
faces lets the name occupant suppress `sidebar.brand.mark` while it is mounted;
the collapsed rail (no name occupant) keeps the standalone globe in the mark
slot, and the hero keeps its own globe. The light/dark PNGs switch through
local CSS with no host DOM access or cropping.

Known limits, documented rather than solved: with more than one `SidebarRoot`
at once, any mounted name hides every mark from the same apply; the real App
has one sidebar. On first paint the rail may show one frame without the globe
before the name-mount signal settles (the default is empty mark, avoiding a
wide-row double-globe flash).

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
