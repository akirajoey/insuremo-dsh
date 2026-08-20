# `@icomposer/insuremo-service`

Host-only IMO CLI capability for the Workbench. `ImoCliService`
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
call remote APIs, or provide UI. `ImoUpgradeService` and the Auth actions seam
below are the only side-effecting surfaces; both require an approved operation
record.

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

The package also mounts a real `insuremo` provider into Harness
`@deepseek-ai/dsh-skill` during plugin apply. It uses the global inventory,
assigns rank 450 (between user-dsh and user-agents), and emits only healthy
kebab-case candidates with canonical `SKILL.md` paths and directory resource
bases. The provider accepts only its opaque issued locators, repeats home-root
realpath/regular-file checks in `get()`, and reads the body on demand only.
Frontmatter closes within 64 KiB and complete files are capped at 1 MiB;
invalid YAML, unclosed/oversize files, missing files, and escaped symlinks are
unloadable without taking healthy candidates out of the catalog. Metadata is a
small allowlist of scalar fields; names/descriptions remain inventory-owned.
Inventory fingerprint changes call the real registry invalidator once, while a
first observation establishes a baseline and avoids list→event→invalidate
loops. Inventory fingerprints intentionally cover structure (name,
description, path), not same-path body edits; later approved write actions must
call the safe host-internal `invalidateInsuremoSkillCatalog(ctx)` signal after a
successful mutation. Disposal unregisters the provider and stops
invalidation/loads.

### Durable activation gate

Installed and enabled are deliberately separate. The first successful global
inventory adopts the currently valid Harness skill names as enabled, preserving
the existing 16-skill experience. The durable
`workbench_imo_skill_activation` v1 domain stores only the global activation
record (`initialized`, sorted `enabledNames`, monotonic `revision`, and
`updatedAt`). A later installed name is reported as `disabled` until an
approval action explicitly enables it; removed enabled names are reported as
`stale` and can be cleared by reconcile. Activation storage failures are
fail-closed: the provider exposes no new candidates and reports an incomplete
observation. Activation changes increment the revision once and emit only
bounded counts/revision metadata, which drives one catalog invalidation. The
public `ctx.imoSkillActivation` value is a frozen two-method read facade;
enable/disable/reconcile stay in an internal composition closure for the
approval action seam. Both provider `list()` and `get()` take a final
revision/enabled snapshot after scanning or body loading, so a completed
disable cannot publish an old candidate. Owner disposal synchronously revokes
both the read facade and internal controller; late calls return the fixed
`service-disposed` error, queued work is skipped, in-flight writes drain, and
the domain opened by the runtime is closed exactly once.

The JSON storage backend is a single-host, single-writer medium for this
state. Two independent `JsonStorageBackend` instances pointed at the same
root are unsupported by Harness: there is no cross-process CAS and concurrent
writers can produce last-writer-wins behavior. The Workbench serializes one
service instance and uses expected revisions for its approval boundary; it
does not claim multi-context atomicity or add a second lock layer.

## Architecture

The Host package keeps domain seams independent of the barrel:

- `src/config.ts` owns shared loader configuration and defaults;
- `src/run.ts` owns the `ctx.subprocess` runner, deadlines, digests, and
  allowlisted status classification;
- `src/cli.ts`, `src/upgrade.ts`, and `src/skills.ts` own their respective
  service contracts and implementations; `src/skill-path.ts` shares the
  containment resolver and `src/skill-provider.ts` owns real Harness catalog
  registration and bounded on-demand loading;
- `src/auth/index.ts` is the controlled Auth domain barrel: `types.ts` holds
  lease contracts, `sanitize.ts` owns allowlists/URL parsing, `lease.ts` owns
  opaque leases, `service.ts` owns cache/coalescing/invalidation, and
  `environment.ts`/`actions.ts`/`action-types.ts` own the approval-gated Auth
  write seam;
- `src/skill-actions/` is the Skills write-action seam: `types.ts` defines the
  four kinds, `validation.ts` normalizes strict source/agent/argv inputs,
  `preview.ts` performs read-only previews, `diff.ts` snapshots bounded
  inventory digests, `finalize.ts` emits the single approved receipt, and
  `service.ts` owns the approved `ctx.imoSkillActions` closed loop;
- `src/index.ts` is only the public export/context augmentation and plugin
  composition boundary. `operation-log-face.ts` remains the structural
  operation-log dependency and no domain module imports the bundle.

Auth cache state and lease secrets remain module-owned/private to the Auth
submodule; `run.ts` never returns raw stdout/stderr on failure.

## Skills write actions

`ctx.imoSkillActions` is the approved write seam for `skill-install`,
`skill-update`, `skill-remove`, and `skill-activation`. It is mounted by the
root composition closure once the internal activation controller is live, and
it never enters the Context object graph. Requests run read-only previews
first (install `--list`, remove/update inventory snapshots, activation
revision capture) and only append an operation-log record afterwards; pending
arguments live only in process memory, so a restart returns
`missing-pending-input`. Execution is gated by `exists / approved /
digest-bound / not executed / busy` before any spawn, then a successful run
diffs the bounded global inventory (name + manifest digest), reconciles or
preserves activation, and performs one safe catalog invalidation. Only
global scope is accepted today; project returns `workspace-not-bound` until
Phase 3. Install never auto-enables a new skill; remove clears stale names;
update leaves the enabled set untouched; activation uses the captured expected
revision as a CAS so a concurrent change finalizes a failed receipt. Sources
are typed (`alias`, HTTPS git with an allowlisted host and stripped
userinfo/query/hash, strict npm grammar, the five built-in scenarios), agents
come from the CLI allowlist, `--yes` is appended by the service, and root
`install --all` / `remove --all` are rejected.

Each approval runs against an in-memory one-shot journal
(`prepared -> executing -> executed`), published once per external attempt and
revoked on disposal. After an attempt the immutable receipt is built with its
digest first, then evidence is recorded; if `recordResult` is temporarily
unavailable the same receipt is returned with `evidencePending`, and the next
`execute` retries only the evidence write — zero spawn, zero controller, zero
invalidation — emitting the event at most once. An indeterminate failure
returns `execution-outcome-unknown` and is never re-run; once the external
attempt has started, best-effort recovery (after inventory snapshot, stale
reconcile for install/remove, safe catalog invalidation) always runs in a
contained `finally`, so a partial write cannot leave the catalog stale and the
failed run still records one receipt. The journal is memory-only: a crash
loses pending arguments and the journal, so an approved-but-unrecorded action
returns `missing-pending-input` and requires manual reconciliation — this
seam does not claim cross-process exactly-once. Install receipts carry
`sourceKind` / `sourceHost?` / `sourceDigest` (a digest over the canonical
sanitized descriptor, never the raw URL) and non-install receipts carry an
`actionTargetDigest`; the completion/failure event mirrors the same allowlist.

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
callback that performs the remote call and does not return the secret.

## Auth actions approval loop

`ImoAuthActionsService` provides `ctx.imoAuthActions` with separate request and
execute methods for portal login, remote-profile creation, and default-profile
switching. Each request appends a pending operation record; the existing
operation-log decision is required before any write command can spawn.

`listEnvironmentIds()` runs `imo complete --type env` and filters strict full
IDs: segmented alphanumeric IDs contain `_insuremo_`, reject option-like and
sensitive token/OAuth/cookie/state/secret-like segments, and are replaced per
source-profile key. `resolveEnvironmentHint()` returns an exact candidate or a
sanitized not-found/ambiguous result; remote requests accept only resolver-
confirmed IDs from the same source key. Portal login always uses `--env portal`;
manual and non-portal requests are rejected. Receipts and action events contain
only digests, status, exit code, timestamps, and sanitized profile/environment
metadata. Pending action arguments are process-memory only and are lost on
restart. No action uses `--insecure`; tests and real smoke never run auth writes.
