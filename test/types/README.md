# TASK-167a — published-declaration contract

Compiles a strict contract against the **published** `@deepseek-ai/*` declarations
for both target versions, and proves the compiler used them.

```sh
node test/types/run.mjs
```

## How it runs

1. Downloads (or reuses a cached) tarball for every package in the plugin's type
   closure — **rc.2 (`0.2.1-rc.2`) and rc.5 (`0.2.1-rc.5`) separately** — into a
   throwaway `/tmp` project. `cordis@4.0.5` and `schemastery@3.18.5` are separate
   published packages, the same versions in both DSH releases.
2. Links the repo's already-installed React/Node type packages (no install, no
   lockfile or `node_modules` mutation).
3. Copies `contract.ts` / `negative.ts` next to that `node_modules` and writes a
   temporary `tsconfig` per version.
4. Compiles `contract.ts` with `strict`, `--listFiles` and `--traceResolution`.
   The gate requires exit 0, the target declaration files in `--listFiles`, a
   `successfully resolved` trace for `@deepseek-ai/dsh-client-ui-slots`, and
   **no** repo `harness-shims.d.ts` or sibling `deepseek-harness` path. That is
   why the gate does not depend on a sibling Harness checkout: resolution starts
   from the temp project's own `node_modules`, and the runner rejects any trace
   that reaches the checkout or a shim.
5. Compiles `negative.ts` in its own project and requires a **non-zero exit with
   at least three diagnostics**, all inside `negative.ts`. A negative case that
   starts passing would make that project exit 0 and fail the gate; the positive
   file is not part of the negative project, so a positive failure cannot be
   mistaken for a rejection.
6. Deletes its `/tmp` project in `finally`, including after a failure.

The contract project uses a temporary project plus registry tarballs only; it
does **not** add repository dependencies, lockfile entries, build artifacts,
snapshots, or `node_modules` content.

## What the contract covers

`contract.ts` exercises the surfaces the 13 harness shims currently declare, all
through real packages: Cordis `Context`/`Service`/`effect`/service faces,
`dsh-subprocess`, `dsh-storage-domain`, `dsh-workspace`, `dsh-jobs` (root and
`/view`), `dsh-tools`, `dsh-system-prompt`, `dsh-skill`, `dsh-llm`,
`dsh-native-command`, `dsh-storage`, `schemastery`, `dsh-api-workspace-controller`,
and the client surfaces `dsh-client-ui-slots` (+ owner-declared slot/locale
tables), `dsh-client-ui-renderer/client` (`ctx.slots`), `dsh-client-locale/client`,
`dsh-client-ui-settings/client`, `dsh-client-ui-sidebar/client`,
`dsh-client-ui-session/client`, `dsh-client-ui-chat/client`, and
`dsh-client-ui-primitives`.

`negative.ts` requires real rejections for: an undeclared locale key, a slot
registry assigned to a string, a malformed `spawn` spec, a numeric workspace id,
and a tool definition without `output`.

## Boundaries

- This proves the **published declaration surface** used by the plugin, not
  runtime behaviour, rc.5 execution, or a full build.
- `skipLibCheck` is on (standard for third-party declarations); our own contract
  files are fully strict.
- Version selection is by tarball: rc.2 and rc.5 are compiled independently.
- The repo package typechecks still resolve `@deepseek-ai/*` through their
  existing shims/source paths; replacing those requires real packages as
  devDependencies (TASK-171) and, for nine packages, business-source type fixes
  (TASK-172). See `SHIM-AUDIT.md`.
