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

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-settings run test
pnpm --filter @icomposer/ui-insuremo-settings run bundle
```
