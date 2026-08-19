# `@icomposer/ui-insuremo-settings`

Host/client Workbench plugin for the first Settings > InsureMO section. Phase 1
intentionally renders only the localized title, a static not-configured state,
and a placeholder for the later IMO, Skills, authentication, and workspace
surfaces.

The package has no host behavior yet. Its browser half registers the
`settings.section` slot and is bundled with the Harness Strategy A
`clientBundle` preset, which keeps React in the browser module table rather
than copying it into `lib/client.js`.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-insuremo-settings run test
pnpm --filter @icomposer/ui-insuremo-settings run bundle
```
