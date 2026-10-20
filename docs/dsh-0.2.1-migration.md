# DSH 0.2.1 isolated plugin development

Development branch: `upgrade/dsh-0.2.1`, based on the existing plugin branch
`desktop` at `dc457fb`. That branch name is historical; no Desktop application
code or release is changed. The old `desktop` and `plugin-dist` branches remain
on their existing commits; this migration is not published to the old channel.

Baseline: upstream `687f282e8625c6b8d11ff58211a90524be2e4317`, npm
`@deepseek-ai/dsh@0.2.1-rc.2`. Plugin tooling uses pnpm 11.7.0; the upstream
source manifest uses pnpm 11.28.5. Node 22.19+ or 24+ is required.

Work only in the two `upgrade-dsh-0.2.1` worktrees. Never link old node_modules,
install globally, use `~/.dsh`, restart an existing service, or push plugin-dist.
The bootstrap channel descriptors still identify their existing, older release
commits; this migration does not publish or retarget those releases.

## Setup and checks (no service started)

```sh
node scripts/setup-isolated.mjs
pnpm check
pnpm typecheck
pnpm bundle
pnpm pack:dist
pnpm pack:git-dist
pnpm check:git-dist
node scripts/test-migration.mjs
```

Setup installs a minimal compiler/test toolchain and the **exact npm runtime**
under `../deepseek-harness/.migration-tools`. Its new local node_modules is used
only by the isolated source worktree; no full harness build or desktop work is
needed. The repository's pnpm lock controls the plugin toolchain.

## Optional real browser/HTTP smoke

All CLI calls below use the explicit packaged runtime. The wrapper defaults to
help, never starts a service automatically, rejects DSH_HOME outside the upgrade
workspace, and supplies a private OS HOME, working directory, and absolute
fixture IMO command. DSH_HOME **alone is insufficient**: real IMO CLI profiles
live outside DSH. Do not bypass the wrapper for a credential-free smoke.

```sh
export DSH_HOME="$PWD/.dsh-home/migration"
node scripts/isolated-dsh.mjs plugin --profile web add "$PWD/dist-release/icomposer-workbench-0.1.0.tgz"
# When refreshing an existing installation, remove @icomposer/workbench first.
# Start ONLY a new test instance, on an OS-assigned port; stop this instance after testing.
node scripts/isolated-dsh.mjs web --host 127.0.0.1 --port 0 --no-open
```

In another terminal in this checkout, copy the printed **test** URL (including
token), then:

```sh
DSH_HOME="$PWD/.dsh-home/migration" \
DSH_SMOKE_URL='http://127.0.0.1:<ephemeral-port>/?token=<test-token>' \
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node test/migration-browser-smoke.mjs
```

Alternatively install Playwright Chromium into an isolated cache and set
`PLAYWRIGHT_BROWSERS_PATH` for this command. No browser download is automatic.
The smoke attaches only; it never launches/restarts/kills a service. It validates
real plugin/client activation, overview and PNG HTTP routes, Settings > InsureMO,
workspace-scoped Active Profile persistence, and diagnosis navigation/prefill.
Only the failing installer and its diagnostic payload are browser-intercepted:
no installer/global npm operation occurs, while workspace/session creation and
draft prefill use the actual latest dsh. Nothing is sent to a model or remote IMO.
Evidence and screenshot are written under `.migration-logs/` (ignored).

## Migration seams

- Producers own message source kinds; read `Session.snapshotEvents()`. Dedup also
  recognizes migrated `plugin:<producer>` rows and current compact checkpoints.
- Background jobs use `exec.agent.session.id` and `run(job).append(text, options)`.
- Clients use Cordis Context, current `mainView` retention in the Session list,
  `uiWorkspace` navigation, and the existing session input kit.
- The unchanged InsureMO card is an independent `settings.section`.
- tsdown 0.22 / upstream `clientBundle(packageDirectory, ...)` emits fresh payloads.
  Owned brand PNGs remain separate host-served assets.

## Validation performed

- `pnpm check`, `pnpm typecheck`, build/pack and payload drift checks passed.
- Focused migration regression: 215 passed, one opt-in real-project/auth test
  deliberately skipped. A clean-shell background-job test also passes without
  `DSH_HOME` (it creates its own temporary home).
- The actual npm 0.2.1-rc.2 CLI installed the tarball and served the plugin on an
  ephemeral port. Browser/HTTP smoke verified the InsureMO Settings section,
  brand assets, diagnosis workspace/session draft handoff, and workspace-scoped
  profile persistence with fixture-only profiles; no browser errors.
- The original dsh is still 0.1.0-rc.7, its existing web process on port 3080
  still responds HTTP 200. A pre/post comparison of 1,740 original library,
  profile and credentials files found no changes. No old service restart,
  global package update, or old distribution-branch change was performed.

Existing narrow ambient shims remain; they are not a substitute for the real
runtime/browser smoke. Real credentials, remote operations and installer execution
are deliberately not exercised. The old opt-in real-project test is skipped by
default (`WORKBENCH_REAL_PROJECT_SMOKE`); do not enable it for this migration.
