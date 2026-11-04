# `@icomposer/ui-insuremo-settings`

Host/client Workbench plugin for the Settings > InsureMO section (Phase 2
read-only overview).

The browser half registers the `settings.section` slot and renders a read-only
InsureMO overview fetched from the same-origin
`/api/icomposer-workbench/insuremo/overview` bridge:

- IMO CLI version and update availability;
- sanitized authentication profiles (name / env / tenant / validity only —
  never a token);
- installed / valid / enabled / disabled skill counts and a bounded name
  list;
- operation counts (no parameters, artifacts, or digests);
- fixed diagnostic badges.

The payload is projected through a narrow client-side validator that rebuilds
the view from an allowlist of fields, so a token, path, or digest that ever
leaked from the host would not reach the DOM. The section is a class component
with plain-document fetches and no React hooks, matching the harness client
renderer. It implements loading / error / refresh states, `zh` and `en` copy,
and accessibly-labelled tables, live regions, and buttons. It never renders
dirty HTML or raw text from the host.

This is a web-only, same-origin read bridge. A write transport (POST /
approve / execute) is intentionally deferred; its CSRF and Origin design is a
documented Phase 2 risk in the host handoff, not this package.

## One-click install/update diagnosis (TASK-083)

When an IMO CLI install/update or a Skills install/update fails, the failed
region renders a 诊断 (Diagnose) button — only in the failed state; success or
an empty failure store renders none. Clicking it fetches the last failure's
full capture from the same-origin `imo-diagnosis` action (server-redacted,
memory-only), assembles a localized diagnosis text (scene, executed commands,
exit code, stdout/stderr code blocks, environment, and a closing
"please analyze the failure and give fix steps" line), and hands it to a
session in the dedicated install-diagnostics Workspace. The flow reuses or
creates the Workspace, connects a session, queues the text and opens that
session; the session-scoped entry writes the draft only if it is still empty.
TASK-086: every label and operation name follows the Settings locale through
the card's own translator seat — switching the UI language re-renders the card
and the next click uses the new language, no restart — while raw material
(commands, operation ids, stdout/stderr, error code/message, environment
values) is never translated.

Only a confirmed draft write invokes the public `settings.section` owner's
`close` callback. A dropped, failed, timed-out or clipboard-only hand-off does
not close the panel. Direct legacy consumers without a `close` callback safely
leave Settings open; no synthetic global Escape is dispatched. When the
Workspace/session capability is unavailable, the text falls back to the
clipboard instead of creating an unrelated session. Nothing is sent
automatically.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-settings run test
pnpm --filter @icomposer/ui-insuremo-settings run bundle
```
