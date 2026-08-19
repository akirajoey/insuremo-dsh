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
provide UI. `upgradeCheck()` is the only upgrade-related read in the read-only
seam.

## Approved upgrade loop

`ImoUpgradeService` provides `ctx.imoUpgrade` — the approval-gated, single-
instance IMO upgrade closed loop:

- `requestUpgrade(targetVersion?)` appends a pending `imo-upgrade` operation
  record (with a params digest) and returns its `operationId`;
- the operator approves/rejects the record through the existing
  `operationLog.decide` API (not reimplemented here);
- `executeUpgrade(operationId)` refuses to start unless the record is
  `approved` (no process is spawned otherwise), enforces one in-flight upgrade
  (`busy`), records the pre/post versions, runs
  `imo upgrade [--version X] --yes` and the read-only smoke battery, and writes
  a digest-only receipt back through `operationLog.recordResult`;
- failures (non-zero exit, timeout) produce a `status: 'failed'` receipt with
  exit code, stderr digest, and an explicit restore command — the service never
  downgrades automatically.

Every child process still routes through `ctx.subprocess` with explicit argv,
stdio limits, a grace period, and a deadline AbortSignal. The loop never runs a
real upgrade implicitly: it requires a prior approval, and a real run further
requires an explicit operator authorization (`[REAL_RUN]`) — tests run only
against fake `imo` scripts.

```sh
pnpm --filter @icomposer/insuremo-service run test
```
