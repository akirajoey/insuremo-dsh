# `@icomposer/ui-workbench-jobs`

Client-side renderer for a Workbench background job as a keyed
`conversation.chat.node` entry (`workbench-job`). It shows an icon, the
producer kind/label, a localized queued/running/done/failed badge, and an
optional digest-only progress string. There are no action buttons or local
job state in this phase.

The Harness `jobsBySession` mirror remains the source of truth. This package
exports `projectJobView()` for the small `JobView` → Chat-node projection, but
the durable event-to-node producer is intentionally deferred to a later Host
card; current tests therefore exercise the renderer with explicit node props.

The browser bundle uses the Harness Strategy A `clientBundle` preset.

```sh
pnpm run typecheck
pnpm --filter @icomposer/ui-workbench-jobs run test
pnpm --filter @icomposer/ui-workbench-jobs run bundle
```
