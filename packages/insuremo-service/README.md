# `@icomposer/insuremo-service`

Host-only, read-only IMO CLI capability for the Workbench. `ImoCliService`
provides `ctx.imoCli` with:

- `probe()` — resolve the configured `imo` executable without starting it;
- `version()` — run `imo --version` and return the parsed version plus a
  SHA-256 stdout digest;
- `upgradeCheck()` — run `imo upgrade --check` and return current/target
  versions, update availability, and a SHA-256 stdout digest.

Every child operation goes through Harness `ctx.subprocess` with explicit
argv, cwd, stdio collection limits, grace period, and an AbortSignal deadline.
No shell is used, no environment is passed explicitly, and credential-shaped
ambient variables remain governed by the Harness subprocess scrubber. Failures
are returned as structured `ImoResult` errors; raw stdout/stderr is never
stored or returned.

The package does not install or upgrade IMO, authenticate, call remote APIs, or
provide UI. `upgradeCheck()` is the only upgrade-related command in this phase.

```sh
pnpm --filter @icomposer/insuremo-service run typecheck
pnpm --filter @icomposer/insuremo-service run test
```
