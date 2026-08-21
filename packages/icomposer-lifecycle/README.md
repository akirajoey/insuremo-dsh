# @icomposer/icomposer-lifecycle

Read-only iComposer init/reload **preview** (dry-run) for a bound workspace.
Host-only, injects `[subprocess, workspaceBinding, imoAuth]`, frozen face:

- `initPreview({ workspaceId, groupId?, listGroups? }, signal?)`
- `reloadPreview({ workspaceId }, signal?)`

No mutating flows are ever executed: `init` runs only with `--dry-run --json`,
`reload` is a **pure local pre-check** (no `imo … reload` invocation).

## initPreview

- Resolves the workspace binding, then inside an `imoAuth.prepare({profile:
  binding.authProfile, env: binding.environmentId})` lease runs
  `imo icomposer init --dry-run --json --profile <authProfile>` (plus
  `--list-groups` and/or `--group-id` when requested). `--profile` always comes
  from the binding; `-k/--insecure` is never used. `cwd` is the workspace
  canonical path. argv pieces are strictly validated (auth profile/environment
  character classes, group id digits only) so nothing injects shell syntax.
- stdout/stderr are digest-only (`sha256:`); JSON stdout is parsed within a
  1MB bound and projected through a strict allowlist: `groups`
  (`id/name/path/code`, fields ≤128 chars) or `plan` (`group_id`, `steps`
  strings each ≤200 chars). Lists are capped at 1000 with a `truncated` flag.
  Hostile/unknown fields (tokens, internal paths, module payloads) never
  cross the projection.

## reloadPreview

Pure local deduction with no subprocess: scans the workspace `.metadata` +
`src/dev` trees and reports the local join-status distribution
(`clean`/`local-modified`/`no-server-md5`/`source-missing`/`metadata-missing`)
plus ≤50 top asset names — a reload pre-check. Real `imo icomposer reload`
(write transport) is deferred to Phase 5.

## Errors

`workspace-not-bound`/`workspace-not-found`/`invalid-workspace-id`/
`invalid-group-id`; auth subset `invalid-auth`/`forbidden`/
`prepare-invalidated`/`lease-revoked`; cli `command-failed`/`timeout`/
`parse-error`; `service-disposed`/`cancelled`. Unknown binding/auth codes fall
back to `cli-error` with a fixed message.
