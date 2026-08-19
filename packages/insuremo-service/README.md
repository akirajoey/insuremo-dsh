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

The read-only `ImoCliService` does not install or upgrade IMO, authenticate,
call remote APIs, or provide UI. The separate `ImoUpgradeService` below is the
only side-effecting surface and requires an approved operation record.

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

## Read-only Skills inventory

`ImoSkillsService` provides `ctx.imoSkills` with three read-only operations:

- `list('project' | 'global')` runs `imo skills list --json [-g]`, preserving
  the reported `{ name, description, path }` rows and returning only a
  stdout digest alongside them;
- `configPath()` runs `imo skills config path`; a missing config file is a
  normal `{ exists: false }` result;
- `validate(scope)` resolves each listed path under the current `homedir()`
  only, rejects lexical and realpath/symlink escapes before candidate access,
  and checks `SKILL.md` without aborting the whole inventory when one row is
  damaged. The result exposes `inventoryComplete` and per-row reasons.

The package also includes an `InsuremoSkillProvider` skeleton, a no-op
`registerInsuremoSkillProvider()` placeholder, and an internal bounded,
containment-checked frontmatter reader. Wiring that provider into the Harness
`@deepseek-ai/dsh-skill` catalog is intentionally a separate follow-up card:
the catalog's provider precedence and filesystem registration surface require
more than this inventory-only phase.

## Architecture

The Host package keeps domain seams independent of the barrel:

- `src/config.ts` owns shared loader configuration and defaults;
- `src/run.ts` owns the `ctx.subprocess` runner, deadlines, digests, and
  allowlisted status classification;
- `src/cli.ts`, `src/upgrade.ts`, and `src/skills.ts` own their respective
  service contracts and implementations;
- `src/auth/index.ts` is the controlled Auth domain barrel: `types.ts` holds
  public contracts, `sanitize.ts` owns allowlists/URL parsing, `lease.ts` owns
  opaque leases, and `service.ts` owns cache/coalescing/invalidation;
- `src/index.ts` is only the public export/context augmentation and plugin
  composition boundary. `operation-log-face.ts` remains the structural
  operation-log dependency and no domain module imports the bundle.

Auth cache state and lease secrets remain module-owned/private to the Auth
submodule; `run.ts` never returns raw stdout/stderr on failure.

## Auth profile and prepare lease

`ImoAuthService` provides `ctx.imoAuth` as the only authentication seam for
future remote tools:

- `listProfiles()` uses `imo auth profile list --format json` and constructs a
  fixed allowlist view; unknown fields, including token-shaped fields, are
  discarded;
- `defaultProfile()` exposes only the sanitized profile name and a digest;
- `validate(profile?)` exposes `{ profileName, valid, status?, reason?,
  checkedAt, stdoutDigest }`. 401 is `invalid-auth` and invalidates the matching
  cache key; 403 is `forbidden` and never retries or invalidates;
- `prepare({ profile?, env? })` uses `imo auth prepare ... --json` only in the
  Host process and returns an opaque lease. The access token is held in a
  closure/private field and is available only to `lease.use(callback)`.

Lease JSON, `Object.keys`, object spread, `util.inspect`, structured clone,
events, logs, operation records, and error messages contain only sanitized view
and in-memory cache metadata. Same-key calls coalesce and reuse until explicit
`invalidate()`; fiber disposal clears the cache. The `lease.use` callback owns
responsibility for its secret: returning, logging, or throwing the token can
still intentionally leak it, which the service cannot prevent. Prefer a
callback that performs the remote call and does not return the secret. Login
and remote-profile creation are intentionally not implemented here, and tests
never invoke real `auth prepare`.
